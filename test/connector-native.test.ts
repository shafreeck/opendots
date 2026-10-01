/** Opt-in L2: unchanged official Runtime + deterministic local model + synthetic
 * public GitHub transport. No credentials, paid models, external API, or desktop. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorHost, connectorHostRegistration } from '../src/connector-host.ts';
import { ConnectorRuntimeClient } from '../src/connector-runtime.ts';
import { GitHubPublicConnector } from '../src/connector-github-public.ts';
import { CONNECTOR_TOOL, ConnectorError, type ConnectorEnvelope } from '../src/connector-types.ts';

test('official Runtime commits a real connector host-tool receipt and exact native provenance', { skip: !process.env.OPENDOTS_RUNTIME_BINARY, timeout: 60_000 }, async () => {
  const binary = resolve(process.env.OPENDOTS_RUNTIME_BINARY!);
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), '29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3', 'Only the already verified official binary is accepted');
  const root = mkdtempSync(join(tmpdir(), 'opendots-connector-native-'));
  mkdirSync(join(root, 'workspace'), { mode: 0o700 });
  const binding = { principalId: 'connector-fixture-principal', agentId: 'connector-fixture-agent', contextId: 'connector-fixture-context', sessionId: 'connector-fixture-session' };
  const token = randomBytes(32).toString('hex'), callbackToken = randomBytes(32).toString('hex');
  let child: ChildProcess | undefined, host: ConnectorHost | undefined, db: DatabaseSync | undefined;
  let fixtureFailure: unknown, callbackFailure: unknown, modelCalls = 0, githubCalls = 0, callbackCalls = 0;
  let actualEnvelope: ConnectorEnvelope | undefined, finished = false;
  const body = async (request: AsyncIterable<Buffer | string>) => { const chunks: Buffer[] = []; let size = 0; for await (const c of request) { const b = Buffer.from(c); size += b.length; assert.ok(size <= 4 * 1024 * 1024); chunks.push(b); } return JSON.parse(Buffer.concat(chunks).toString()); };
  const provider = createServer(async (request, response) => {
    try {
      const input = await body(request); modelCalls++;
      assert.ok(modelCalls <= 5, 'Local model fixture must remain bounded');
      const tool = (input.messages ?? []).find((m: any) => m.role === 'tool');
      let message: any, finish: string;
      if (!tool) {
        assert.ok(input.tools.some((t: any) => t.function?.name === CONNECTOR_TOOL));
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'connector-fixed-call', type: 'function', function: { name: CONNECTOR_TOOL, arguments: JSON.stringify({ action: 'call', connector: 'github_public', operation: 'get_repo', parameters: { repository: 'morphz-ai/morphz' } }) } }] }; finish = 'tool_calls';
      } else {
        assert.ok(JSON.stringify(tool).includes('github_public_rest'), 'Actual provider continuation must receive the host connector result');
        message = { role: 'assistant', content: 'CONNECTOR_NATIVE_FIXTURE_DONE' }; finish = 'stop'; finished = true;
      }
      if (input.stream) {
        const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((c: any) => ({ ...c, index: 0 })) } : message;
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
      } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: randomUUID(), choices: [{ index: 0, message, finish_reason: finish }] })); }
    } catch (error) { fixtureFailure = error; response.writeHead(500); response.end('Local fixture failed'); }
  });
  const callback = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/connector'); callbackCalls++;
      actualEnvelope = await body(request);
      const result = await host!.handle(request.headers.authorization, actualEnvelope);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { callbackFailure = error; response.writeHead(error instanceof ConnectorError ? error.status : 500); response.end('Connector rejected'); }
  });
  const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
  const closeServer = async (server: Server) => { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const providerPort = await listen(provider), callbackPort = await listen(callback);
    const probe = createServer(); const runtimePort = await listen(probe); await closeServer(probe);
    const origin = `http://127.0.0.1:${runtimePort}`;
    const manifest = join(root, 'host-tools.json'), config = join(root, 'runtime.toml');
    writeFileSync(manifest, JSON.stringify({ protocol: 1, tools: [connectorHostRegistration({ contextId: binding.contextId, endpoint: `http://127.0.0.1:${callbackPort}/connector`, token: callbackToken })] }), { mode: 0o600 });
    writeFileSync(config, `[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(join(root, 'workspace'))}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root, 'artifacts'))}\n`, { mode: 0o600 });
    child = spawn(binary, ['serve','--bind',`127.0.0.1:${runtimePort}`,'--cwd',root,'--config-file',config,'--log-level','warn'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MORPHZ_HOME: join(root,'home'), MORPHZ_DASHBOARD_TOKEN: token, MORPHZ_HOST_TOOLS_FILE: manifest, MORPHZ_PRINCIPAL_ID: binding.principalId, MORPHZ_STORAGE_SQLITE_PATH: join(root,'runtime.db'), LANG: 'C.UTF-8' }, stdio: ['ignore','ignore','ignore'] });
    child.on('error', () => { fixtureFailure = Error('Isolated Runtime spawn failed'); });
    const api = async (path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST') => {
      const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(3_000), redirect: 'error' });
      assert.ok(response.ok, `Fixture Runtime HTTP ${response.status}`); return response.json() as Promise<any>;
    };
    const wait = async (check: () => Promise<boolean>) => {
      const until = Date.now() + 25_000;
      while (Date.now() < until) { if (fixtureFailure) throw fixtureFailure; if (callbackFailure) throw callbackFailure; assert.equal(child!.exitCode, null); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw Error('Bounded native connector fixture timed out');
    };
    await wait(async () => { try { return (await api('/api/session-io/capabilities')).enabled === true; } catch { return false; } });
    await api('/api/agents', { id: binding.agentId, root_context_id: binding.contextId, initial_session_id: binding.sessionId, title: 'Disposable connector fixture' });
    await api(`/api/agents/${binding.agentId}/provider-accounts/fixture`, undefined, 'PUT');
    const runtime = new ConnectorRuntimeClient({ baseUrl: origin, binding, operatorToken: token });
    assert.ok((await runtime.catalogue()).targets.some(t => t.id === 'target-default' && t.capabilities.includes(CONNECTOR_TOOL)));
    db = new DatabaseSync(join(root, 'product.db'));
    host = new ConnectorHost({ db, token: callbackToken, runtime, adapters: [new GitHubPublicConnector({ repositories: ['morphz-ai/morphz'], fetch: async (url, init) => {
      githubCalls++; assert.equal(String(url), 'https://api.github.com/repos/morphz-ai/morphz'); assert.equal(new Headers(init?.headers).has('authorization'), false);
      return Response.json({ full_name: 'morphz-ai/morphz', private: false, html_url: 'https://github.com/morphz-ai/morphz', description: 'SYNTHETIC PUBLIC API RESPONSE' });
    } })], authorize: async envelope => { assert.equal(envelope.invocation.session_id, binding.sessionId); } });
    await api(`/api/sessions/${binding.sessionId}/io/messages`, { io_version: '1', client_message_id: 'connector-native-fixed-input', message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: 'Run the one bounded synthetic public repository read fixture.' } } }, activation: { dispatch_mode: 'parallel' } });
    await wait(async () => (await api(`/api/sessions/${binding.sessionId}/io/events`)).events.some((e: any) => e.type === 'output.committed' && JSON.stringify(e).includes('CONNECTOR_NATIVE_FIXTURE_DONE')));
    assert.equal(finished, true); assert.equal(githubCalls, 1); assert.equal(callbackCalls, 1); assert.ok(actualEnvelope);
    const job = await api(`/api/execution-jobs/${actualEnvelope.invocation.job_id}`); assert.equal(job.status, 'succeeded');
    const retried = await host.handle(`Bearer ${callbackToken}`, actualEnvelope); assert.equal(retried.replayed, true); assert.equal(retried.status, 'succeeded'); assert.equal(githubCalls, 1);
    console.log(JSON.stringify({ level: 'L2', runtime: 'unchanged official v0.1.3', sourceCommit: '7e8f7d81f8b00fd45544d94d5b9a321214633df1', callbackCalls, githubTransport: 'synthetic', githubCalls, model: 'deterministic loopback', modelCalls, paidCalls: 0, nativeJobStatus: job.status, replayAfterCompletion: retried.replayed }));
  } finally {
    await host?.close(); await closeServer(callback); await closeServer(provider);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => { const timer = setTimeout(() => child!.kill('SIGKILL'), 2_000); child!.once('close', () => { clearTimeout(timer); resolve(); }); });
    }
    db?.close(); rmSync(root, { recursive: true, force: true });
  }
});
