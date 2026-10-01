import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConfiguredConnectors, CONNECTOR_CALLBACK_PATH } from '../src/connector-service.ts';
import { readConnectorConfig } from '../src/connector-config.ts';
import { CONNECTOR_TOOL, ConnectorError } from '../src/connector-types.ts';

async function fixture(t: test.TestContext, options: { githubFetch?: typeof fetch; nativeWait?: () => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opendots-connector-http-')), configPath = join(root, 'connectors.json');
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  const binding = { principalId: 'principal', agentId: 'agent', contextId: 'context', sessionId: 'session' };
  const raw = { version: 1, ownerId: 'owner', runtimeOrigin: 'http://127.0.0.1:43210', binding, callbackPort: port, callbackToken: 't'.repeat(64), allowPublicGithubReads: true, repositories: ['morphz-ai/morphz'] };
  writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 }); const config = readConnectorConfig(configPath);
  const db = new DatabaseSync(':memory:'); let githubCalls = 0, nativeCalls = 0, savedVerified = true;
  const args = { action: 'call', connector: 'github_public', operation: 'get_repo', parameters: { repository: 'morphz-ai/morphz' } };
  const invocation = { job_id: 'job', tool_call_id: 'call', thread_id: 'thread', target_id: 'target-default', principal_id: 'principal', agent_id: 'agent', context_id: 'context', session_id: 'session' };
  const envelope = { protocol: 1, tool: CONNECTOR_TOOL, invocation, arguments: args };
  const store = { db, binding: () => ({ userId: 'owner', ...binding, runtimeOrigin: raw.runtimeOrigin, verified: savedVerified }) };
  const service = new ConfiguredConnectors({ configPath, config, runtimeOrigin: raw.runtimeOrigin, operatorToken: 'OPERATOR_TEST_ONLY', store, githubFetch: async (...a) => { githubCalls++; return options.githubFetch ? options.githubFetch(...a) : Response.json({ private: false, full_name: 'morphz-ai/morphz', html_url: 'https://github.com/morphz-ai/morphz' }); }, runtimeFetch: async url => {
    nativeCalls++; const path = new URL(String(url)).pathname;
    if (path === '/api/execution-jobs/job') { await options.nativeWait?.(); return Response.json({ id: 'job', ...invocation, initiating_principal_id: 'principal', tool_name: CONNECTOR_TOOL, request: { ...args, _morphz_execution_route: { target_id: 'target-default', backend_kind: 'in_process_local' }, _morphz_wake_thread: false }, status: 'running', cancel_requested_at: null }); }
    if (path === '/api/contexts/context/threads/thread') return Response.json({ snapshot: { thread: { id: 'thread', ...invocation, initiating_principal_id: 'principal', lifecycle: 'open', control_state: 'active' } } });
    if (path === '/api/execution-targets') return Response.json({ targets: [{ id: 'target-default', revision: 1, kind: 'in_process_local', status: 'online', capabilities: [CONNECTOR_TOOL], metadata: { secret: 'OMITTED' } }] });
    if (path === '/api/sessions/session/principal') return Response.json({ principal_id: 'principal', context_id: 'context', session_id: 'session' });
    assert.equal(path, '/api/sessions/session'); return Response.json({ id: 'session', agent_id: 'agent', context_id: 'context' });
  } });
  t.after(async () => { await service.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const post = (input: unknown = envelope, headers: Record<string, string> = {}, path = CONNECTOR_CALLBACK_PATH) => fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${config.callbackToken}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  return { service, db, store, config, configPath, raw, origin, envelope, post, githubCalls: () => githubCalls, nativeCalls: () => nativeCalls, unverify: () => { savedVerified = false; } };
}
test('dedicated callback starts only after native identity verification; inventory never probes GitHub', async t => {
  const f = await fixture(t); assert.equal(f.nativeCalls(), 0); assert.equal(f.githubCalls(), 0);
  assert.equal(f.service.catalogue().accountConnected, false); await f.service.start();
  assert.equal(f.nativeCalls(), 2); assert.equal(f.githubCalls(), 0); assert.equal(f.service.snapshot().callbackListening, true);
  await f.service.nativeCatalogue(); assert.equal(f.nativeCalls(), 3); assert.equal(f.githubCalls(), 0); assert.equal(f.service.snapshot().nativeRegistration, 'advertised');
  assert.ok(!JSON.stringify(f.service.catalogue()).includes(f.config.callbackToken));
});
test('HTTP callback requires native bearer, numeric host and non-browser channel before any native proof', async t => {
  const f = await fixture(t); await f.service.start(); const baseline = f.nativeCalls();
  const rejectedHeaders: Array<Record<string, string>> = [{ authorization: 'Bearer wrong' }, { authorization: 'Bearer OPERATOR_TEST_ONLY' }, { cookie: 'opendots_session=browser' }, { origin: f.origin }, { 'sec-fetch-site': 'none' }, { 'x-opendots-csrf': 'browser-token' }];
  for (const headers of rejectedHeaders) { const r = await f.post(f.envelope, headers); assert.ok([401,403].includes(r.status)); }
  assert.equal((await f.post(f.envelope, {}, CONNECTOR_CALLBACK_PATH + '?x=1')).status, 404);
  assert.equal((await fetch(f.origin + CONNECTOR_CALLBACK_PATH)).status, 404);
  const wrongHost = await new Promise<number>((resolve, reject) => { const r = httpRequest(f.origin + CONNECTOR_CALLBACK_PATH, { method: 'POST', headers: { host: 'localhost:' + f.config.callbackPort, authorization: `Bearer ${f.config.callbackToken}`, 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode!); }); r.on('error', reject); r.end(JSON.stringify(f.envelope)); });
  assert.equal(wrongHost, 403); assert.equal(f.nativeCalls(), baseline); assert.equal(f.githubCalls(), 0);
});
test('real HTTP callback validates native Job, persists receipt and deduplicates exact retry', async t => {
  const f = await fixture(t); await f.service.start();
  const first = await f.post(); assert.equal(first.status, 200); const receipt = await first.json(); assert.equal(receipt.status, 'succeeded'); assert.equal(f.githubCalls(), 1);
  const second = await (await f.post()).json(); assert.equal(second.id, receipt.id); assert.equal(second.replayed, true); assert.equal(f.githubCalls(), 1);
  assert.ok(!JSON.stringify(receipt).includes(f.config.callbackToken));
});
test('callback enforces body/media bounds and exact native arguments', async t => {
  const f = await fixture(t); await f.service.start();
  assert.equal((await f.post(f.envelope, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.post({ ...f.envelope, padding: 'x'.repeat(70_000) })).status, 413);
  const swapped = { ...f.envelope, invocation: { ...f.envelope.invocation, principal_id: 'other' } };
  assert.equal((await f.post(swapped)).status, 403); assert.equal(f.githubCalls(), 0);
});
test('changed/revoked private config or saved owner blocks new calls and receipt replay', async t => {
  const f = await fixture(t); await f.service.start(); await f.post();
  writeFileSync(f.configPath, JSON.stringify({ ...f.raw, repositories: ['other/repository'] }), { mode: 0o600 });
  assert.equal((await f.post()).status, 403); assert.equal(f.githubCalls(), 1);
  writeFileSync(f.configPath, JSON.stringify(f.raw), { mode: 0o600 }); f.unverify();
  assert.equal((await f.post()).status, 403); assert.equal(f.githubCalls(), 1);
});
test('shutdown aborts and drains admitted HTTP handlers before shared SQLite may close', async t => {
  let began!: () => void; const started = new Promise<void>(r => { began = r; });
  const f = await fixture(t, { githubFetch: async (_url, options) => { began(); return new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), { once: true }); }); } });
  await f.service.start(); const request = f.post().then(r => r.json()).catch(() => null); await started;
  const firstClose = f.service.close(), secondClose = f.service.close(); assert.equal(firstClose, secondClose); await firstClose; await request;
  assert.equal(f.service.snapshot().status, 'closed'); assert.equal(f.service.snapshot().callbackListening, false);
  assert.equal(f.db.prepare('SELECT state FROM connector_receipts').get()!.state, 'unknown'); assert.equal(f.githubCalls(), 1);
  assert.throws(() => f.service.catalogue(), ConnectorError);
});
test('configuration revocation while native Job proof is pending blocks dispatch', async t => {
  let finish!: () => void, began!: () => void; const started = new Promise<void>(r => { began = r; });
  const f = await fixture(t, { nativeWait: async () => { began(); await new Promise<void>(r => { finish = r; }); } });
  await f.service.start(); const request = f.post(); await started;
  writeFileSync(f.configPath, JSON.stringify({ ...f.raw, allowPublicGithubReads: false }), { mode: 0o600 }); finish();
  assert.equal((await request).status, 403); assert.equal(f.githubCalls(), 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM connector_receipts').get()!.n, 0);
});
test('callback port conflict fails closed without replacing the existing listener', async t => {
  const f = await fixture(t); const existing = createServer((_request, response) => response.end('existing'));
  await new Promise<void>(r => existing.listen(f.config.callbackPort, '127.0.0.1', r));
  t.after(async () => { existing.closeAllConnections(); await new Promise<void>(r => existing.close(() => r())); });
  await assert.rejects(f.service.start(), ConnectorError); assert.equal(f.service.snapshot().status, 'unavailable'); assert.equal(f.githubCalls(), 0);
  assert.equal(await (await fetch(f.origin)).text(), 'existing');
});
test('configuration mismatches or unverified saved binding cannot start provisioning', async t => {
  const f = await fixture(t); const old = readFileSync(f.configPath, 'utf8');
  assert.throws(() => new ConfiguredConnectors({ configPath: f.configPath, config: f.config, runtimeOrigin: f.raw.runtimeOrigin, operatorToken: f.config.callbackToken, store: f.store }), ConnectorError);
  f.unverify(); assert.throws(() => new ConfiguredConnectors({ configPath: f.configPath, config: f.config, runtimeOrigin: f.raw.runtimeOrigin, store: f.store }), ConnectorError);
  assert.equal(readFileSync(f.configPath, 'utf8'), old); assert.equal(f.nativeCalls(), 0); assert.equal(f.githubCalls(), 0);
});
