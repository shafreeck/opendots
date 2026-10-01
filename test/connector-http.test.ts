import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/runtime-store.ts';
import { createApplication } from '../src/server.ts';
import { authDigest } from '../src/auth-config.ts';
import { ConnectorError, CONNECTOR_TOOL } from '../src/connector-types.ts';
import { CONNECTOR_CALLBACK_PATH } from '../src/connector-service.ts';

async function fixture(t: test.TestContext, options: { catalogueWait?: () => Promise<void>; githubFetch?: typeof fetch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opendots-connector-bff-')), dbPath = join(root, 'product.sqlite'), authConfigPath = join(root, 'auth.json'), connectorConfigPath = join(root, 'connector.json');
  const baseUrl = 'http://127.0.0.1:49981', principalId = 'native-fixture-principal';
  const saved = new RuntimeStore(dbPath), b = saved.ensureBinding(baseUrl);
  const session = { id: b.sessionId, agent_id: b.agentId, context_id: b.contextId, status: 'active' };
  const verified = saved.verifyBinding(session, principalId); saved.close();
  const binding = { principalId, agentId: b.agentId, contextId: b.contextId, sessionId: b.sessionId };
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const callbackPort = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  const credential = 'b'.repeat(64), callbackToken = 'c'.repeat(64);
  writeFileSync(authConfigPath, JSON.stringify({ version: 1, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest(credential) }, sessionTtlSeconds: 3600, idleTtlSeconds: 600, maximumDevices: 4 }), { mode: 0o600 });
  const config = { version: 1, ownerId: verified.userId, runtimeOrigin: baseUrl, binding, callbackPort, callbackToken, allowPublicGithubReads: true, repositories: ['morphz-ai/morphz'] };
  writeFileSync(connectorConfigPath, JSON.stringify(config), { mode: 0o600 });
  const args = { action: 'call', connector: 'github_public', operation: 'get_repo', parameters: { repository: 'morphz-ai/morphz' } };
  const invocation = { job_id: 'native-job', tool_call_id: 'native-call', thread_id: 'native-thread', target_id: 'target-default', principal_id: principalId, agent_id: b.agentId, context_id: b.contextId, session_id: b.sessionId };
  const envelope = { protocol: 1, tool: CONNECTOR_TOOL, invocation, arguments: args };
  let githubCalls = 0, nativeCalls = 0;
  const runtimeFetch: typeof fetch = async (url, init) => {
    nativeCalls++; assert.equal(init?.method, 'GET'); const path = new URL(String(url)).pathname;
    if (path === '/api/execution-targets') { await options.catalogueWait?.(); return Response.json({ targets: [{ id: 'target-default', revision: 1, kind: 'in_process_local', status: 'online', capabilities: [CONNECTOR_TOOL] }] }); }
    if (path === '/api/execution-jobs/native-job') return Response.json({ id: 'native-job', ...invocation, initiating_principal_id: principalId, tool_name: CONNECTOR_TOOL, request: { ...args, _morphz_execution_route: { target_id: 'target-default', backend_kind: 'in_process_local' }, _morphz_wake_thread: false }, status: 'running', cancel_requested_at: null });
    if (path === `/api/contexts/${b.contextId}/threads/native-thread`) return Response.json({ snapshot: { thread: { id: 'native-thread', ...invocation, initiating_principal_id: principalId, lifecycle: 'open', control_state: 'active' } } });
    if (path === `/api/sessions/${b.sessionId}/principal`) return Response.json({ principal_id: principalId, session_id: b.sessionId, context_id: b.contextId });
    assert.equal(path, `/api/sessions/${b.sessionId}`); return Response.json(session);
  };
  const app = createApplication({ dbPath, baseUrl, operatorToken: 'OPERATOR_TEST_ONLY', autoStart: false, authConfigPath, connectorConfigPath, fetch: runtimeFetch, connectorGithubFetch: async (...args) => { githubCalls++; return options.githubFetch ? options.githubFetch(...args) : Response.json({ private: false, full_name: 'morphz-ai/morphz', html_url: 'https://github.com/morphz-ai/morphz' }); } });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); await app.ready; await app.connectors!.start();
  const origin = `http://127.0.0.1:${(app.server.address() as any).port}`, callbackOrigin = `http://127.0.0.1:${callbackPort}`;
  const loginResponse = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential, deviceLabel: 'Connector test browser' }) });
  assert.equal(loginResponse.status, 200); const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!, authSession = (await loginResponse.json()).session;
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const postCallback = (headers: Record<string, string> = {}) => fetch(callbackOrigin + CONNECTOR_CALLBACK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${callbackToken}`, ...headers }, body: JSON.stringify(envelope) });
  return { root, app, dbPath, origin, callbackOrigin, cookie, authSession, credential, callbackToken, config, connectorConfigPath, envelope, postCallback, githubCalls: () => githubCalls, nativeCalls: () => nativeCalls };
}
test('BFF connector inventory requires owner session and never exposes callback credentials or probes GitHub', async t => {
  const f = await fixture(t); const nativeCalls = f.nativeCalls(); assert.equal(f.githubCalls(), 0);
  for (const path of ['/api/connectors','/api/connectors/native']) assert.equal((await fetch(f.origin + path)).status, 401);
  assert.equal((await fetch(f.origin + '/api/connectors', { headers: { authorization: `Bearer ${f.callbackToken}` } })).status, 401);
  const inventory = await (await fetch(f.origin + '/api/connectors', { headers: { cookie: f.cookie } })).json();
  assert.equal(inventory.status, 'ready'); assert.equal(inventory.accountConnected, false); assert.equal(inventory.nativeRegistration, 'unverified');
  assert.ok(!JSON.stringify(inventory).includes(f.callbackToken)); assert.equal(f.nativeCalls(), nativeCalls); assert.equal(f.githubCalls(), 0);
  const native = await (await fetch(f.origin + '/api/connectors/native', { headers: { cookie: f.cookie } })).json(); assert.equal(native.evidence, 'declared_capabilities_only'); assert.equal(f.githubCalls(), 0);
});
test('native callback is separate from browser owner sessions and cannot bypass main BFF auth', async t => {
  const f = await fixture(t);
  const main = await fetch(f.origin + CONNECTOR_CALLBACK_PATH, { method: 'POST', headers: { origin: f.origin, authorization: `Bearer ${f.callbackToken}`, 'content-type': 'application/json' }, body: JSON.stringify(f.envelope) }); assert.equal(main.status, 401);
  assert.equal((await f.postCallback({ cookie: f.cookie })).status, 403);
  assert.equal((await f.postCallback({ authorization: `Bearer ${f.credential}` })).status, 401);
  const first = await (await f.postCallback()).json(); assert.equal(first.status, 'succeeded'); assert.equal(f.githubCalls(), 1);
  const retry = await (await f.postCallback()).json(); assert.equal(retry.id, first.id); assert.equal(retry.replayed, true); assert.equal(f.githubCalls(), 1);
});
test('owner revocation during native catalogue fetch suppresses the late private response', async t => {
  let ready!: () => void, finish!: () => void; const began = new Promise<void>(r => { ready = r; });
  const f = await fixture(t, { catalogueWait: async () => { ready(); await new Promise<void>(r => { finish = r; }); } });
  const pending = fetch(f.origin + '/api/connectors/native', { headers: { cookie: f.cookie } }); await began;
  const logout = await fetch(f.origin + '/api/auth/logout', { method: 'POST', headers: { origin: f.origin, cookie: f.cookie, 'x-opendots-csrf': f.authSession.csrfToken, 'content-type': 'application/json' }, body: '{}' }); assert.equal(logout.status, 200);
  finish(); const response = await pending; assert.equal(response.status, 401); assert.equal((await response.json()).code, 'authentication_required');
});
test('application shutdown aborts and drains native callback before closing shared database', async t => {
  let began!: () => void; const started = new Promise<void>(r => { began = r; });
  const f = await fixture(t, { githubFetch: async (_url, options) => { began(); return new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), { once: true }); }); } });
  const request = f.postCallback().catch(() => null); await started; await f.app.close(); await request;
  const db = new DatabaseSync(f.dbPath); try { assert.equal(db.prepare('SELECT state FROM connector_receipts').get()!.state, 'unknown'); } finally { db.close(); }
  assert.equal(f.app.connectors!.snapshot().callbackListening, false);
});
test('connector launcher does not initialize a new native identity or permit reused owner credential', async t => {
  const f = await fixture(t);
  assert.throws(() => createApplication({ dbPath: join(f.root, 'fresh.sqlite'), baseUrl: f.config.runtimeOrigin, autoStart: false, connectorConfigPath: f.connectorConfigPath }), e => e instanceof ConnectorError && e.code === 'connector_saved_binding_required');
  writeFileSync(f.connectorConfigPath, JSON.stringify({ ...f.config, callbackToken: f.credential }), { mode: 0o600 });
  assert.throws(() => createApplication({ dbPath: f.dbPath, baseUrl: f.config.runtimeOrigin, autoStart: false, authConfigPath: join(f.root, 'auth.json'), connectorConfigPath: f.connectorConfigPath }), e => e instanceof ConnectorError && e.code === 'connector_separate_callback_token_required');
});
