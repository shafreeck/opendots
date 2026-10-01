/** L2: unmodified pinned Runtime + real BFF + a genuinely running shell tool.
 * Only the model is synthetic. Its responses are never held to fake concurrency.
 * Uses an isolated profile, loopback provider, and no external credentials.
 * --non-sandbox-fixture explicitly opts this disposable instance into the
 * supported full_access preset. It proves product behavior, not confinement.
 * --directed-input-fixture additionally proves exact existing-Objective input
 * admission, generation fencing, durable retries, and subsequent model input.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function readExecReceipt(messages) {
  for (const message of messages ?? []) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const outer = JSON.parse(message.content);
      if (outer.tool_name === 'exec') return typeof outer.result === 'string' ? JSON.parse(outer.result) : outer.result;
    } catch { /* Another tool message is not an exec receipt. */ }
  }
}
function requireSucceededExec(receipt) {
  assert.ok(receipt, 'Runtime must return the actual exec result');
  if (receipt.exit_code !== 0 || receipt.process_status !== 'succeeded') {
    throw Error(`Actual exec failed before concurrency could be verified (exit ${receipt.exit_code ?? 'unknown'}): ${String(receipt.output ?? '').trim()}`);
  }
}
if (process.argv.includes('--fixture-self-test')) {
  const receipt = { kind: 'exec_result', execution: 'completed', process_status: 'succeeded', exit_code: 0, output: 'LONG_TOOL_FINISHED\n' };
  const wire = value => [{ role: 'tool', content: JSON.stringify({ tool_name: 'exec', result: JSON.stringify(value) }) }];
  assert.deepEqual(readExecReceipt(wire(receipt)), receipt);
  requireSucceededExec(readExecReceipt(wire(receipt)));
  assert.throws(() => requireSucceededExec(readExecReceipt(wire({ ...receipt, process_status: 'failed', exit_code: 1, output: 'bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted\n' }))), /exit 1.*NETLINK_ROUTE socket: Operation not permitted/);
  assert.throws(() => requireSucceededExec(undefined), /actual exec result/);
  console.log('Fixture-only receipt checks passed. No Runtime or concurrency claim.');
  process.exit(0);
}

const { createApplication } = await import('../src/server.ts');
const binary = process.env.OPENDOTS_RUNTIME_BINARY;
const nonSandboxFixture = process.argv.includes('--non-sandbox-fixture');
const directedInputFixture = process.argv.includes('--directed-input-fixture');
assert.ok(process.argv.slice(2).every(argument => ['--non-sandbox-fixture', '--directed-input-fixture'].includes(argument)), 'Unsupported fixture option');
assert.ok(!directedInputFixture || nonSandboxFixture, 'Directed-input product validation requires explicit --non-sandbox-fixture opt-in');
const fixtureMode = nonSandboxFixture ? 'NON-SANDBOX product fixture' : 'default native sandbox';
if (!binary || !existsSync(binary)) throw Error('Set OPENDOTS_RUNTIME_BINARY to the verified official Morphz binary. No automatic download or paid provider calls.');
const version = spawnSync(resolve(binary), ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout?.trim();
assert.equal(version, 'morphz 0.1.3 (git 7e8f7d81f8b00fd45544d94d5b9a321214633df1)', 'This test targets the pinned, unmodified Runtime contract');
const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'opendots-real-long-tool-'));
const token = randomBytes(32).toString('hex');
const startedPath = join(root, 'tool-started.txt');
const finishedPath = join(root, 'tool-finished.txt');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// The command is finite independently of the test: sleep 8s, with an outer 12s
// timeout and 1s kill grace. No '&', escalation, persistent service, or network.
const command = `timeout --signal=TERM --kill-after=1s 12s /bin/sh -c ${quote("printf 'LONG_TOOL_STARTED\\n' > tool-started.txt; sleep 8; printf 'LONG_TOOL_FINISHED\\n' > tool-finished.txt; printf 'LONG_TOOL_FINISHED\\n'")}`;
let runtime, app, appOrigin, runtimeOrigin, csrf, objectiveId, contextId, sessionId;
let runtimeOutput = '', providerCalls = 0, objectiveStage = 0, fixtureFailure, execReceipt;
let foregroundModelObservedAt, foregroundCommittedAt, startedObservedAt, runningJob;
let supplementBody, supplementReceipt, supplementAdmittedAt, supplementalModelObservedAt;
const supplementText = 'EXACT_OBJECTIVE_SUPPLEMENT_FIXTURE: retain the fixed shell command; include this supplemental marker in the existing Objective continuation.';
const observedRuntimeMutations = [];
const observingFetch = async (url, init = {}) => {
  if (init.method && init.method !== 'GET') observedRuntimeMutations.push({ path: new URL(String(url)).pathname, method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
  return fetch(url, init); // Observation only: forward the real request unchanged.
};
const directedPosts = () => observedRuntimeMutations.filter(call => call.path.endsWith('/io/messages') && call.body?.activation?.input_destination);
const seenTools = new Set();
const toolResults = [];
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4_000_000, 'Bounded fixture input'); }
    const input = JSON.parse(raw); providerCalls++;
    for (const tool of input.tools ?? []) seenTools.add(tool.function?.name);
    for (const message of input.messages ?? []) if (message.role === 'tool') toolResults.push(message.content);
    const objectiveBound = /\(objective-binding (?:\(id )?"?objective-/.test(JSON.stringify(input.messages));
    if (objectiveBound && JSON.stringify(input.messages).includes(supplementText)) supplementalModelObservedAt = Date.now();
    let call, text;
    if (objectiveBound) {
      if (objectiveStage === 0) {
        const definition = input.tools.find(tool => tool.function?.name === 'exec');
        assert.ok(definition, 'Actual Runtime must advertise exec');
        assert.ok(definition.function.parameters.properties.command);
        assert.ok(definition.function.parameters.properties.wait_ms);
        objectiveStage = 1;
        call = { id: 'long-tool-exec', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command, cwd: root, wait_ms: 10_000, background: false, keep_running: false }) } };
      } else if (objectiveStage === 1) {
        execReceipt = readExecReceipt(input.messages);
        requireSucceededExec(execReceipt);
        assert.equal(execReceipt.effective_boundary?.sandbox_status, nonSandboxFixture ? 'disabled' : 'enforced', 'Verify the actual execution boundary rather than assuming config took effect');
        assert.equal(readFileSync(finishedPath, 'utf8'), 'LONG_TOOL_FINISHED\n', 'Never complete on a spawn receipt');
        assert.ok(toolResults.some(result => String(result).includes('LONG_TOOL_FINISHED')), 'Runtime returned actual shell output');
        assert.ok(foregroundCommittedAt, 'Foreground reply must already be committed');
        if (directedInputFixture) assert.ok(supplementalModelObservedAt, 'A following Objective model request must contain the exact supplemental text');
        const overview = await runtimeApi(`/api/contexts/${contextId}/overview`);
        const objective = overview.objectives.find(value => value.id === objectiveId);
        assert.ok(objective, 'Objective remains Runtime-owned');
        objectiveStage = 2;
        call = { id: 'long-tool-complete', type: 'function', function: { name: 'objective_update', arguments: JSON.stringify({ objective_id: objectiveId, base_revision: objective.revision, status: 'completed', reason: 'The bounded exec finished and its marker bytes and tool output were verified.', evidence_refs: [] }) } };
      } else text = 'LONG_TOOL_OBJECTIVE_DONE';
    } else {
      assert.ok(JSON.stringify(input.messages).includes('FOREGROUND_DURING_LONG_TOOL'), 'Only the explicitly submitted foreground chat is expected');
      assert.ok(existsSync(startedPath), 'Foreground model called after real child started');
      assert.equal(existsSync(finishedPath), false, 'Foreground model must run before the child finishes');
      foregroundModelObservedAt = Date.now();
      text = 'FOREGROUND_COMMITTED_WHILE_TOOL_RUNNING';
    }
    const message = call ? { role: 'assistant', content: '', tool_calls: [call] } : { role: 'assistant', content: text };
    const finish_reason = call ? 'tool_calls' : 'stop';
    // Respond immediately: concurrency is exercised in exec, not in the fixture.
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: 'assistant', tool_calls: [{ ...call, index: 0 }] } : message, finish_reason }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: randomUUID(), choices: [{ index: 0, message, finish_reason }] }));
    }
  } catch (error) { fixtureFailure = error; response.writeHead(500); response.end('Controlled fixture assertion failed'); }
});
const listen = server => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function runtimeApi(path, body) {
  const response = await fetch(runtimeOrigin + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw Error(`Runtime HTTP ${response.status}: ${path}`);
  return result;
}
async function productApi(path, body, expectedStatus) {
  const response = await fetch(appOrigin + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-opendots-csrf': csrf ?? '' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (expectedStatus !== undefined) { assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(result)}`); return result; }
  if (!response.ok) throw Error(`Product HTTP ${response.status}: ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function wait(check, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fixtureFailure) throw fixtureFailure;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null)) throw Error(`Runtime exited before ${label}: ${runtimeOutput}`);
    if (await check()) return;
    await delay(50);
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function stopRuntime() {
  if (!runtime || runtime.exitCode !== null || runtime.signalCode !== null) return;
  const exited = new Promise(resolveExit => runtime.once('exit', resolveExit));
  runtime.kill('SIGTERM');
  const killTimer = setTimeout(() => runtime.kill('SIGKILL'), 5000);
  await exited; clearTimeout(killTimer);
}

try {
  await listen(provider);
  const probe = createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolveClose => probe.close(resolveClose));
  runtimeOrigin = `http://127.0.0.1:${port}`;
  const config = join(root, 'runtime.toml');
  // full_access also enables the instance's effective network boundary upstream.
  // The fixed fixture command has no network operation; no host policy changes.
  writeFileSync(config, `[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="${nonSandboxFixture ? 'full_access' : 'request_approval'}"\nworkspace_root=${JSON.stringify(root)}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root, 'artifacts'))}\n`, { mode: 0o600 });
  runtime = spawn(resolve(binary), ['serve', '--bind', `127.0.0.1:${port}`, '--cwd', root, '--config-file', config, '--log-level', 'warn'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MORPHZ_HOME: join(root, 'home'), MORPHZ_DASHBOARD_TOKEN: token, MORPHZ_STORAGE_SQLITE_PATH: join(root, 'runtime.db'), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.once('error', error => { fixtureFailure = error; });
  for (const stream of [runtime.stdout, runtime.stderr]) stream.on('data', data => { runtimeOutput = (runtimeOutput + data.toString()).slice(-12_000); });
  await wait(async () => { try { return (await runtimeApi('/api/session-io/capabilities')).enabled; } catch { return false; } }, 'Runtime readiness');
  app = createApplication({ dbPath: join(root, 'product.db'), baseUrl: runtimeOrigin, operatorToken: token, pollIntervalMs: 100, fetch: observingFetch });
  await listen(app.server); appOrigin = `http://127.0.0.1:${app.server.address().port}`;
  await wait(async () => { const state = await productApi('/api/state'); csrf = state.csrfToken; return state.runtime.status === 'ready'; }, 'real BFF readiness');
  const state = await productApi('/api/state'); sessionId = state.sessionId; contextId = state.binding.contextId;
  await productApi('/api/models/account', { accountId: 'fixture' });
  const admitted = await productApi('/api/jobs', { prompt: 'Run the controlled bounded eight-second shell command, verify its output, and complete.', idempotencyKey: 'long-tool-objective-key' });
  objectiveId = admitted.receipt.objective.id;
  await wait(() => existsSync(startedPath), 'actual exec start marker'); startedObservedAt = Date.now();
  assert.equal(readFileSync(startedPath, 'utf8'), 'LONG_TOOL_STARTED\n');
  assert.equal(existsSync(finishedPath), false);
  await wait(async () => {
    const listing = await runtimeApi(`/api/execution-jobs?session_id=${encodeURIComponent(sessionId)}&include_terminal=true&limit=100`);
    runningJob = listing.jobs.find(job => job.tool_call_id === 'long-tool-exec' && job.tool_name === 'exec' && job.status === 'running');
    return Boolean(runningJob);
  }, 'authoritative running exec Job');
  assert.equal((await productApi('/api/state')).jobs.find(job => job.id === objectiveId)?.status, 'active');
  await productApi('/api/chat', { text: 'FOREGROUND_DURING_LONG_TOOL: reply immediately while the Objective shell command is still running.', idempotencyKey: 'foreground-long-tool-chat' });
  await wait(async () => {
    const current = await productApi('/api/state');
    return current.messages.some(message => message.role === 'assistant' && message.text === 'FOREGROUND_COMMITTED_WHILE_TOOL_RUNNING');
  }, 'real BFF committed foreground reply', 6000);
  foregroundCommittedAt = Date.now();
  assert.equal(existsSync(finishedPath), false, 'A committed foreground response must beat tool completion');
  const runningAfterChat = await runtimeApi(`/api/execution-jobs?session_id=${encodeURIComponent(sessionId)}&include_terminal=true&limit=100`);
  assert.equal(runningAfterChat.jobs.find(job => job.id === runningJob.id)?.status, 'running', 'Runtime confirms exec still running after chat is committed');
  assert.equal((await productApi('/api/state')).jobs.find(job => job.id === objectiveId)?.status, 'active', 'Chat does not terminalize the Objective');
  if (directedInputFixture) {
    const target = await productApi(`/api/jobs/${objectiveId}/input-target`);
    assert.equal(target.available, true); assert.equal(target.objectiveId, objectiveId); assert.equal(target.status, 'active');
    assert.ok(Number.isSafeInteger(target.generation) && target.generation > 0);
    const beforeInvalid = observedRuntimeMutations.filter(call => call.path.endsWith('/io/messages')).length;
    const rejected = await productApi(`/api/jobs/${objectiveId}/input`, { text: supplementText, idempotencyKey: 'wrong-generation-supplement', expectedGeneration: target.generation + 1 }, 409);
    assert.match(rejected.error, /generation changed/i);
    assert.equal(observedRuntimeMutations.filter(call => call.path.endsWith('/io/messages')).length, beforeInvalid, 'Generation mismatch rejected before native admission');
    supplementBody = { text: supplementText, idempotencyKey: 'exact-objective-supplement', expectedGeneration: target.generation };
    const admittedSupplement = await productApi(`/api/jobs/${objectiveId}/input`, supplementBody, 202);
    supplementReceipt = admittedSupplement.receipt; supplementAdmittedAt = Date.now();
    assert.equal(supplementReceipt.accepted, true); assert.equal(supplementReceipt.session_id, sessionId);
    assert.equal(existsSync(finishedPath), false, 'Supplement admitted while the same real shell is still running');
    const repeatedSupplement = await productApi(`/api/jobs/${objectiveId}/input`, supplementBody, 202);
    assert.deepEqual(repeatedSupplement.receipt, supplementReceipt);
    assert.equal(directedPosts().length, 1, 'Same-key retry must not add another native input');
    assert.deepEqual(directedPosts()[0].body.activation, { mode: 'evaluate', dispatch_mode: 'parallel', input_destination: { kind: 'objective', objective_id: objectiveId, generation: target.generation } });
    const stillRunning = await runtimeApi(`/api/execution-jobs?session_id=${encodeURIComponent(sessionId)}&include_terminal=true&limit=100`);
    assert.equal(stillRunning.jobs.find(job => job.id === runningJob.id)?.status, 'running', 'Supplement does not cancel or replace the existing physical Job');
    assert.equal((await productApi('/api/state')).jobs.length, 1, 'Supplement does not create another Objective');
  }
  await wait(() => existsSync(finishedPath), 'actual shell completion marker');
  assert.equal(readFileSync(finishedPath, 'utf8'), 'LONG_TOOL_FINISHED\n');
  assert.ok(statSync(finishedPath).mtimeMs - statSync(startedPath).mtimeMs >= 7500, 'The shell genuinely ran for approximately eight seconds');
  await wait(async () => (await productApi('/api/state')).jobs.some(job => job.id === objectiveId && job.status === 'completed'), 'authoritative Objective completion');
  await wait(async () => (await productApi('/api/state')).messages.some(message => message.role === 'assistant' && message.text === 'LONG_TOOL_OBJECTIVE_DONE'), 'Objective final committed reply');
  const finalJobs = await runtimeApi(`/api/execution-jobs?session_id=${encodeURIComponent(sessionId)}&include_terminal=true&limit=100`);
  const finishedJob = finalJobs.jobs.find(job => job.id === runningJob.id);
  assert.equal(finishedJob.status, 'succeeded');
  assert.equal(finishedJob.exit_code, 0);
  const page = await runtimeApi(`/api/sessions/${encodeURIComponent(sessionId)}/io/events`);
  assert.equal(page.events.filter(event => event.type === 'output.committed' && event.message?.content?.value?.text === 'FOREGROUND_COMMITTED_WHILE_TOOL_RUNNING').length, 1);
  assert.equal(page.events.filter(event => event.type === 'output.committed' && event.message?.content?.value?.text === 'LONG_TOOL_OBJECTIVE_DONE').length, 1);
  if (directedInputFixture) {
    assert.ok(supplementalModelObservedAt, 'Exact supplemental text reached a following Objective model request');
    const terminalTarget = await productApi(`/api/jobs/${objectiveId}/input-target`);
    assert.equal(terminalTarget.available, false); assert.equal(terminalTarget.reason, 'objective_terminal');
    const replay = await productApi(`/api/jobs/${objectiveId}/input`, supplementBody, 202);
    assert.deepEqual(replay.receipt, supplementReceipt, 'Accepted receipt survives same-key retry after Objective completion');
    assert.equal(directedPosts().length, 1, 'Post-completion retry never resends native input');
    assert.equal(page.events.filter(event => event.type === 'input.accepted' && event.message?.content?.value?.text === supplementText).length, 1, 'One authoritative supplemental admission');
    const acceptedInput = page.events.find(event => event.event_id === supplementReceipt.event_id);
    assert.ok(acceptedInput); assert.equal(acceptedInput.thread_id, runningJob.thread_id, 'Supplement belongs to the already-running Objective Thread');
    assert.equal(observedRuntimeMutations.filter(call => call.path === '/api/objectives' && call.method === 'POST').length, 1);
    assert.equal(observedRuntimeMutations.some(call => call.body?.activation?.dispatch_mode === 'interrupt' || /\/(cancel|pause|resume)$/.test(call.path)), false, 'No global interrupt or lifecycle-control fallback');
    assert.equal((await productApi('/api/state')).jobs.length, 1);
  }
  assert.ok(seenTools.has('exec')); assert.ok(seenTools.has('objective_update'));
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), binarySha256, 'Runtime binary unchanged');
  console.log(JSON.stringify({ level: 'L2', result: 'passed', fixtureMode, sandboxAssurance: false, effectiveBoundary: execReceipt.effective_boundary, runtime: version, binarySha256, productBff: true, provider: 'immediate deterministic loopback fixture; no held model responses', paidCalls: 0, providerCalls, measured: { shellDurationMs: Math.round(statSync(finishedPath).mtimeMs - statSync(startedPath).mtimeMs), chatCommittedAfterToolStartMs: foregroundCommittedAt - startedObservedAt, foregroundModelAfterToolStartMs: foregroundModelObservedAt - startedObservedAt, ...(directedInputFixture ? { supplementAdmittedAfterToolStartMs: supplementAdmittedAt - startedObservedAt, supplementSeenByObjectiveModelAfterToolStartMs: supplementalModelObservedAt - startedObservedAt } : {}) }, directedInput: directedInputFixture ? { verified: true, exactObjectiveAndGeneration: true, generationMismatchBeforeNativeSideEffect: true, admittedDuringActualExec: true, nativeAdmissions: directedPosts().length, sameReceiptRetryAfterCompletion: true, sameExistingThread: true, supplementalTextInFollowingObjectiveModelInput: true, noGlobalInterruptOrNewObjective: true } : undefined, verified: ['actual bounded fixed exec in temporary working directory', 'Runtime exec Job running before and after foreground committed reply', 'real BFF chat committed before shell finish marker', 'shell stdout and marker bytes', 'exec completed with exit code zero', 'Runtime Objective completion and exactly one final report', 'unmodified pinned Runtime binary'] }, null, 2));
} catch (error) {
  console.error('Runtime long-tool smoke failed:', error.message);
  console.error(JSON.stringify({ level: 'L2', result: 'not_passed', fixtureMode, sandboxAssurance: false, runtime: version, binarySha256, paidCalls: 0, providerCalls, objectiveStage, toolStarted: existsSync(startedPath), toolFinished: existsSync(finishedPath), foregroundCommitted: Boolean(foregroundCommittedAt), execReceipt, runtimeOutput, state: app?.runtime?.snapshot().runtime }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await stopRuntime();
  provider.closeAllConnections();
  await new Promise(resolveClose => provider.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
