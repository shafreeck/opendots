/** L2 streaming/reconnect check against an actual pinned Morphz process.
 * The model is a gated loopback fixture. No user credentials or paid endpoints.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.ts';
const binary = process.env.OPENDOTS_RUNTIME_BINARY;
if (!binary || !existsSync(binary)) throw Error('Set OPENDOTS_RUNTIME_BINARY to a verified pinned Morphz binary.');
const root = mkdtempSync(join(tmpdir(), 'opendots-real-stream-')); const token = randomBytes(32).toString('hex');
let runtime; let app; let output = ''; let providerCalls = 0; const pending = new Set();
let completeModel; const observed = [];
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); providerCalls++;
    assert.equal(input.stream, true, 'The fixture requires actual provider streaming');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = randomUUID();
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: 'STREAM_PREFIX' });
    pending.add(response);
    completeModel = () => { send({ content: '_SUFFIX' }); send({}, 'stop'); response.end('data: [DONE]\n\n'); pending.delete(response); };
  } catch { response.writeHead(500); response.end('Local fixture failure'); }
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(provider); const providerPort = provider.address().port;
const probe = createServer(); await listen(probe); const runtimePort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const config = join(root, 'runtime.toml'); const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
writeFileSync(config, `[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(root)}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root, 'artifacts'))}\n`, { mode: 0o600 });
const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MORPHZ_HOME: join(root, 'home'), MORPHZ_DASHBOARD_TOKEN: token, MORPHZ_STORAGE_SQLITE_PATH: join(root, 'runtime.db'), LANG: 'C.UTF-8' };
async function wait(check, label) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (runtime.exitCode !== null) throw Error('Runtime exited before ' + label); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Timed out waiting for ' + label);
}
async function launchApp() {
  app = createApplication({ dbPath: join(root, 'product.db'), baseUrl: runtimeOrigin, operatorToken: token, pollIntervalMs: 150 });
  const observe = app.runtime.adapter.observeApplication.bind(app.runtime.adapter);
  app.runtime.adapter.observeApplication = (session, signal, receive) => observe(session, signal, event => { observed.push({type:event.type, output_id:event.output_id, root_turn_id:event.root_turn_id, session_id:event.session_id, text:event.text, delta_seq:event.delta_seq}); receive(event); });
  await listen(app.server);
  await wait(() => app.runtime.status.status === 'ready' && app.runtime.snapshot().stream.status === 'connected', 'Runtime bootstrap and actual Session IO stream');
}
try {
  runtime = spawn(resolve(binary), ['serve', '--bind', `127.0.0.1:${runtimePort}`, '--cwd', root, '--config-file', config, '--log-level', 'warn'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [runtime.stdout, runtime.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-12000); });
  await wait(async () => { try { const response = await fetch(runtimeOrigin + '/api/session-io/capabilities', { headers: { authorization: `Bearer ${token}` } }); return response.ok; } catch { return false; } }, 'Runtime startup');
  await launchApp(); await app.runtime.bindProvider({ accountId: 'fixture' });
  const binding = app.runtime.snapshot().binding;
  await app.runtime.sendChat('Reply with the deterministic streamed fixture answer.', 'stream-reconnect-command');
  await wait(() => app.runtime.snapshot().drafts.some(draft => draft.text === 'STREAM_PREFIX'), 'actual intermediate draft');
  assert.equal(app.runtime.snapshot().messages.filter(message => message.role === 'assistant').length, 0, 'An unfinished draft is not a committed message');
  await app.close(); app = undefined;
  await launchApp(); assert.equal(app.runtime.snapshot().binding.sessionId, binding.sessionId);
  assert.equal(app.runtime.snapshot().stream.transport, 'application_ws');
  assert.equal(app.runtime.snapshot().stream.reconnectBehavior, 'discard_unfinished_until_fresh_start_or_durable_output');
  assert.equal(app.runtime.snapshot().drafts.length, 0, 'Pinned upstream cannot recover a complete typed-IO prefix; discard until final rather than fabricate a snapshot');
  assert.equal(providerCalls, 1, 'Host reconnection must not resubmit inference');
  completeModel();
  await wait(() => app.runtime.snapshot().messages.some(message => message.role === 'assistant' && message.text === 'STREAM_PREFIX_SUFFIX'), 'authoritative committed reply');
  await wait(() => app.runtime.snapshot().drafts.length === 0, 'terminal draft removal');
  assert.equal(app.runtime.snapshot().messages.filter(message => message.role === 'assistant').length, 1);
  console.log(JSON.stringify({ level: 'L2', result: 'passed', runtime: 'actual Morphz', provider: 'deterministic gated local fixture', verified: ['intermediate application-WebSocket public text prefix', 'host restart during live inference', 'honest draft discard on reconnect; no fabricated prefix snapshot', 'no input replay on reconnect', 'one authoritative committed output', 'terminal draft removal'], paidCalls: 0, providerCalls }, null, 2));
} catch (error) { console.error('Runtime stream smoke failed:', error.message); console.error(JSON.stringify({providerCalls, observed:observed.slice(-20),status:app?.runtime?.snapshot().runtime,commands:app?.runtime?.snapshot().commands.map(c=>({status:c.status,errorCode:c.errorCode})),events:app?.runtime?.store.events(app.runtime.snapshot().sessionId).map(e=>({type:e.type,topic:e.event?.topic,event_id:e.event_id}))},null,2)); process.exitCode = 1; }
finally {
  if (app) await app.close(); for (const response of pending) response.end();
  if (runtime && runtime.exitCode === null) { runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve)); }
  await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
