/** L2: unchanged official Morphz + real Edge protocol + SYNTHETIC 1px display.
 * Uses isolated ephemeral keys/config and a deterministic loopback model. No paid
 * endpoint, user secret, real desktop, input server, install or production pairing.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ComputerEdgeClient, computerHostManifest, computerPairingRequest } from '../src/computer-edge-client.ts';
import { ComputerEdgeExecutor } from '../src/computer-edge-executor.ts';
import { ComputerApprovals } from '../src/computer-approvals.ts';
import { ComputerControl } from '../src/computer-control.ts';
import { COMPUTER_TOOL } from '../src/computer-edge-types.ts';

const binary = process.env.OPENDOTS_RUNTIME_BINARY;
if (!binary || !existsSync(binary)) throw Error('Set OPENDOTS_RUNTIME_BINARY to the verified unchanged Morphz binary.');
const root = mkdtempSync(join(tmpdir(), 'opendots-computer-edge-fixture-'));
mkdirSync(join(root, 'workspace'), { mode: 0o700 });
const binding = { nodeId: 'computer-fixture-node', targetId: 'computer-fixture-target', principalId: 'computer-fixture-principal', agentId: 'computer-fixture-agent', contextId: 'computer-fixture-context', sessionId: 'computer-fixture-session', policyDigest: createHash('sha256').update('synthetic 1px observation and counted click only').digest('hex') };
const token = randomBytes(32).toString('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64');
const display = { id: 'synthetic-display-only', width: 1, height: 1 };
let runtime, executor, approvals, control, db, worker;
let workerStopped = false, workerFailure, providerFailure;
let providerCalls = 0, phase = 0, modelImageSeen = false, syntheticActions = 0, captures = 0;
let nativeApprovals = 0, productApprovals = 0, localFallbackCalls = 0;
let executionEpoch, modelThread, completed;
let runtimeLog = '';
const observedJobs = [];
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); providerCalls++;
    assert.ok(input.tools?.some(t => t.function?.name === COMPUTER_TOOL), 'The registered host definition must be model-visible');
    const toolTexts = (input.messages ?? []).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    let call;
    if (phase === 0) {
      phase = 1;
      call = { id: 'computer-observe-fixture', type: 'function', function: { name: COMPUTER_TOOL, arguments: JSON.stringify({ target: binding.targetId, action: 'observe', epoch: executionEpoch }) } };
    } else if (phase === 1) {
      const images = (input.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(part => part.type === 'image_url');
      assert.ok(images.length >= 1, 'Screenshot must reach the actual next model request as native image_url content');
      const image = images.find(part => part.image_url?.url?.startsWith('data:image/png;base64,'));
      assert.ok(image, 'Actual provider input must contain a PNG data URL');
      assert.equal(createHash('sha256').update(Buffer.from(image.image_url.url.split(',')[1], 'base64')).digest('hex'), createHash('sha256').update(png).digest('hex'));
      modelImageSeen = true;
      const observed = toolTexts.map(text => { try { const envelope = JSON.parse(text); return typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope; } catch { return null; } }).find(value => value?.observationId);
      assert.ok(observed, 'Native tool observation must retain its exact observation ID');
      assert.equal(observed.epoch, executionEpoch);
      phase = 2;
      call = { id: 'computer-act-fixture', type: 'function', function: { name: COMPUTER_TOOL, arguments: JSON.stringify({ action: 'act', epoch: executionEpoch, observationId: observed.observationId, operation: { type: 'click', x: 0, y: 0, button: 'left' } }) } };
    } else {
      assert.equal(phase, 2); assert.equal(syntheticActions, 1);
      assert.ok(toolTexts.some(text => { try { const envelope=JSON.parse(text); const result=typeof envelope.result==='string'?JSON.parse(envelope.result):envelope; return result.status==='dispatched'; } catch {return false;} }), 'Counted synthetic gesture must have a native tool receipt');
      phase = 3;
    }
    const message = call ? { role: 'assistant', content: '', tool_calls: [call] } : { role: 'assistant', content: 'COMPUTER_EDGE_SYNTHETIC_FIXTURE_DONE' };
    const finish = call ? 'tool_calls' : 'stop';
    if (input.stream) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: 'assistant', tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); }
    else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: randomUUID(), choices: [{ index: 0, message, finish_reason: finish }] })); }
  } catch (error) { providerFailure = error; response.writeHead(500); response.end('Controlled local fixture failed'); }
});
const fallback = createServer((_request, response) => { localFallbackCalls++; response.writeHead(503); response.end('Computer local fallback is disabled'); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(provider); await listen(fallback);
const probe = createServer(); await listen(probe); const runtimePort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${runtimePort}`;
const manifest = join(root, 'host-tools.json'), config = join(root, 'runtime.toml');
writeFileSync(manifest, JSON.stringify(computerHostManifest(binding, `http://127.0.0.1:${fallback.address().port}/disabled`, randomBytes(32).toString('hex'))), { mode: 0o600 });
writeFileSync(config, `[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools","image"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(join(root, 'workspace'))}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root, 'artifacts'))}\n`, { mode: 0o600 });
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw Error(`Fixture Runtime HTTP ${response.status} on ${path}`); }
  return response.json();
}
async function wait(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (runtime.exitCode !== null) throw Error('Runtime exited while waiting for ' + label + ': ' + runtimeLog);
    if (providerFailure) throw providerFailure; if (workerFailure) throw workerFailure;
    if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for ' + label);
}
try {
  runtime = spawn(resolve(binary), ['serve', '--bind', `127.0.0.1:${runtimePort}`, '--cwd', root, '--config-file', config, '--log-level', 'warn'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MORPHZ_HOME: join(root, 'home'), MORPHZ_DASHBOARD_TOKEN: token, MORPHZ_HOST_TOOLS_FILE: manifest, MORPHZ_PRINCIPAL_ID: binding.principalId, MORPHZ_STORAGE_SQLITE_PATH: join(root, 'runtime.db'), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [runtime.stdout, runtime.stderr]) stream.on('data', chunk => { runtimeLog = (runtimeLog + chunk.toString()).slice(-6000); });
  await wait(async () => { try { return (await api('/api/session-io/capabilities')).enabled; } catch { return false; } }, 'native startup');
  await api('/api/agents', { id: binding.agentId, root_context_id: binding.contextId, initial_session_id: binding.sessionId, title: 'Disposable computer protocol fixture' });
  await api(`/api/agents/${binding.agentId}/provider-accounts/fixture`, undefined, 'PUT');
  assert.equal((await api(`/api/sessions/${binding.sessionId}/principal`)).principal_id, binding.principalId);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); // Disposable in-memory fixture identity only.
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const pairing = await api('/api/edge/pairing-codes', { expires_in_seconds: 60 });
  const paired = await api('/api/edge/pair', computerPairingRequest({ code: pairing.code, nodeId: binding.nodeId, name: 'Synthetic fixture worker', publicKeyHex }));
  assert.equal(paired.node.id, binding.nodeId); assert.equal(paired.node.owner_principal_id, binding.principalId);
  const client = new ComputerEdgeClient({ baseUrl: origin, binding, workerId: 'computer-fixture-worker', signConnectionProof: async bytes => sign(null, bytes, privateKey).toString('hex'), claimWaitSeconds: 0 });
  await client.heartbeatNode();
  const target = await api(`/api/execution-targets/${binding.targetId}`);
  assert.deepEqual(target.capabilities, [COMPUTER_TOOL]); assert.equal(target.kind, 'edge_node');
  db = new DatabaseSync(join(root, 'product-edge.db'));
  control = new ComputerControl(join(root, 'control.db')); control.createSession(binding.sessionId);
  executionEpoch = (await control.returnToAi(binding.sessionId, async () => ({ id: 'explicit-synthetic-initial-observation', capturedAt: Date.now() }))).epoch;
  const revalidate = async () => { const p = await api(`/api/sessions/${binding.sessionId}/principal`); assert.equal(p.principal_id, binding.principalId); assert.equal(p.context_id, binding.contextId); };
  approvals = new ComputerApprovals({ db, binding, revalidate, observation: (id, thread, epoch) => executor.approvalObservation(id, thread, epoch), state: () => control.state(binding.sessionId) });
  executor = new ComputerEdgeExecutor({ db, binding, workerId: 'computer-fixture-worker', transport: client,
    arbiter: { state: () => control.state(binding.sessionId), performAi: (epoch, fn) => control.perform({ sessionId: binding.sessionId, owner: 'ai', epoch }, fn), renewAi: epoch => { control.renew({ sessionId: binding.sessionId, owner: 'ai', epoch }); }, pause: (uncertain, epoch) => { control.pause(binding.sessionId, uncertain, epoch); } },
    driver: { display: () => display, capture: async context => { context.assertCurrent(); captures++; return { ...display, png, capturedAt: Date.now() }; }, act: async (action, context) => { context.assertCurrent(); assert.deepEqual(action, { type: 'click', x: 0, y: 0, button: 'left' }); syntheticActions++; } },
    authorize: (scope, request, identity) => { assert.equal(scope.session_id, binding.sessionId); assert.equal(scope.principal_id, binding.principalId); if (modelThread) assert.equal(scope.thread_id, modelThread); else modelThread = scope.thread_id; return approvals.authorize(scope, request, identity); },
  });
  worker = (async () => { try { while (!workerStopped) { const result = await executor.runOnce(); if (result) observedJobs.push(result); await new Promise(resolve => setTimeout(resolve, 50)); } } catch (error) { if (!workerStopped) workerFailure = error; } })();
  const input = { io_version: '1', client_message_id: 'computer-edge-fixed-input', message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: 'Use the controlled synthetic display fixture; observe then perform the one explicitly approved counted click.' } } }, activation: { dispatch_mode: 'parallel' } };
  const receipt = await api(`/api/sessions/${binding.sessionId}/io/messages`, input);
  assert.equal((await api(`/api/sessions/${binding.sessionId}/io/messages`, input)).event_id, receipt.event_id);
  await wait(async () => {
    const native = await api(`/api/sessions/${binding.sessionId}/approvals`);
    for (const approval of native.approvals ?? []) {
      if (!['pending_auto', 'pending_human'].includes(approval.status)) continue;
      assert.equal(approval.target_id, binding.targetId, 'Only this isolated desktop target may be approved');
      assert.ok(JSON.stringify(approval.action).includes(COMPUTER_TOOL), 'Only the synthetic host tool may be approved');
      await api(`/api/sessions/${binding.sessionId}/approvals/${approval.id}`, { expected_revision: approval.revision, decision: 'allow_once' }); nativeApprovals++;
    }
    for (const approval of (await approvals.list()).approvals.filter(value => value.status === 'pending')) {
      assert.equal(syntheticActions, 0, 'No action before the explicit local decision');
      assert.equal(approval.epoch, executionEpoch); assert.equal(approval.threadId, modelThread);
      assert.deepEqual(approval.action, { type: 'click', x: 0, y: 0, button: 'left' });
      assert.equal(createHash('sha256').update(await approvals.image(approval.id)).digest('hex'), createHash('sha256').update(png).digest('hex'));
      await approvals.decide(approval.id, 'allow_once', approval.revision); productApprovals++;
    }
    const events = await api(`/api/sessions/${binding.sessionId}/io/events`);
    completed = events.events.find(e => e.type === 'output.committed' && JSON.stringify(e).includes('COMPUTER_EDGE_SYNTHETIC_FIXTURE_DONE'));
    return Boolean(completed);
  }, 'native image, exact local approval, counted action and committed final', 45_000);
  assert.equal(modelImageSeen, true); assert.equal(syntheticActions, 1); assert.equal(captures, 1); assert.equal(productApprovals, 1); assert.ok(nativeApprovals >= 1); assert.equal(localFallbackCalls, 0);
  const thread = await api(`/api/sessions/${binding.sessionId}/turns/${receipt.event_id}/thread`);
  assert.equal(thread.thread_id, modelThread, 'The input turn retains the same execution Thread');
  const jobs = (await api(`/api/execution-jobs?session_id=${binding.sessionId}&include_terminal=true&limit=100`)).jobs;
  for (const observed of observedJobs) { const job=jobs.find(value=>value.id===observed.jobId); assert.ok(job); assert.equal(job.target_id,binding.targetId); assert.equal(job.thread_id,modelThread); assert.equal(job.session_id,binding.sessionId); assert.equal(job.context_id,binding.contextId); assert.equal(job.agent_id,binding.agentId); assert.equal(job.initiating_principal_id,binding.principalId); }
  assert.equal(observedJobs.filter(job => job.delivered).length, 2);
  console.log(JSON.stringify({ level: 'L2', result: 'passed', runtime: 'actual unchanged Morphz', desktop: 'synthetic 1px image and counted gesture, no real desktop', provider: 'deterministic loopback fixture', paidCalls: 0, providerCalls, nativeApprovals, productApprovals, verified: ['real ephemeral Edge pairing and Ed25519 challenge/connect', 'narrow target publication', 'native claim/heartbeat/finish', 'PNG reaches next provider request as native image content', 'same Principal/Agent/Context/Session/Thread target binding', 'exact local user-decision fixture through ComputerApprovals', 'one counted synthetic action', 'no local text-only callback fallback', 'durable input retry and committed final'] }, null, 2));
} catch (error) {
  console.error('Computer Edge Runtime fixture failed:', error.message);
  console.error(JSON.stringify({ providerCalls, phase, modelImageSeen, syntheticActions, captures, nativeApprovals, productApprovals, localFallbackCalls, observedJobs }, null, 2));
  process.exitCode = 1;
} finally {
  workerStopped = true; approvals?.close(); if (executor) await executor.close(); await worker; control?.close(); db?.close();
  if (runtime && runtime.exitCode === null) { runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve)); }
  await new Promise(resolve => provider.close(resolve)); await new Promise(resolve => fallback.close(resolve)); rmSync(root, { recursive: true, force: true });
}
