import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ComputerEdgeExecutor, COMPUTER_EDGE_LIMITS, computerActionDigest, type ComputerEdgeExecutorOptions } from '../src/computer-edge-executor.ts';
import { ComputerEdgeClient, computerConnectionProof, computerHostManifest, computerPairingRequest } from '../src/computer-edge-client.ts';
import { COMPUTER_TOOL, ComputerEdgeError, parseComputerRequest, type ComputerEdgeBinding, type ComputerEdgeCommand, type ComputerEdgeFinish, type ComputerEdgeLease, type ComputerEdgeTransport } from '../src/computer-edge-types.ts';

const binding: ComputerEdgeBinding = { nodeId: 'node-test', targetId: 'desktop-test', principalId: 'principal-test', agentId: 'agent-test', contextId: 'context-test', sessionId: 'session-test', policyDigest: 'policy-test' };
const workerId = 'worker-test';
const epoch = 7;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5kAAAAASUVORK5CYII=', 'base64');
function command(jobId: string, arguments_: unknown, threadId = 'thread-test'): ComputerEdgeCommand {
  return { job_id: jobId, revision: 1, target_id: binding.targetId, provider_node_id: binding.nodeId, tool_name: COMPUTER_TOOL, arguments: JSON.stringify(arguments_), route: { route_id: 'route-test', target_id: binding.targetId, target_revision: 1, provider_node_id: binding.nodeId, backend_kind: 'edge_node', endpoint_ref: null, policy_digest: binding.policyDigest, execution_scope: { principal_id: binding.principalId, agent_id: binding.agentId, context_id: binding.contextId, session_id: binding.sessionId, thread_id: threadId } }, status: 'claimed', claimed_by: workerId, claim_token: 'claim-test', lease_expires_at: new Date(Date.now() + 30_000).toISOString(), side_effect_started_at: null };
}
class Transport implements ComputerEdgeTransport {
  queue: ComputerEdgeCommand[] = []; finished: { command: ComputerEdgeLease; result: ComputerEdgeFinish }[] = []; beats: boolean[] = [];
  failFinish = false; nodeFailure = false;
  beforeBeat?: (c: ComputerEdgeCommand, effect: boolean) => Promise<ComputerEdgeCommand>;
  async heartbeatNode() { if (this.nodeFailure) throw new Error('private endpoint token'); }
  async claim() { return this.queue.shift() ?? null; }
  async heartbeat(c: ComputerEdgeCommand, effect: boolean) { this.beats.push(effect); return this.beforeBeat ? this.beforeBeat(c, effect) : { ...c, revision: c.revision + 1, lease_expires_at: new Date(Date.now() + 30_000).toISOString() }; }
  async finish(c: ComputerEdgeLease, result: ComputerEdgeFinish) { this.finished.push({ command: structuredClone(c), result: structuredClone(result) }); if (this.failFinish) throw new Error('secret native response'); return { ...c, arguments: '', status: result.status } as ComputerEdgeCommand; }
  close() {}
}
function fixture(extra: Partial<ComputerEdgeExecutorOptions> = {}) {
  const db = new DatabaseSync(':memory:'); const transport = new Transport();
  const state = { owner: 'ai' as 'ai' | 'human' | 'paused' | 'transition', epoch, leaseUntil: Date.now() + 30_000, uncertainty: false };
  const d = { id: 'display-test', width: 1, height: 1 };
  let captures = 0, acts = 0, renews = 0;
  const options: ComputerEdgeExecutorOptions = { db, binding, workerId, transport,
    arbiter: { state: () => state, performAi: async (e, fn) => { assert.equal(e, state.epoch); assert.equal(state.owner, 'ai'); return fn(); }, renewAi: e => { assert.equal(e, state.epoch); assert.equal(state.owner, 'ai'); state.leaseUntil = Date.now() + 30_000; renews++; }, pause: (uncertain, expected) => { if (uncertain) state.uncertainty = true; if (expected === undefined || expected === state.epoch) { state.owner = 'paused'; state.epoch++; state.leaseUntil = 0; } } },
    driver: { display: () => d, capture: async c => { c.assertCurrent(); captures++; return { ...d, png: pixel, capturedAt: Date.now() }; }, act: async (_a, c) => { c.assertCurrent(); acts++; } },
    authorize: async (scope, req, identity) => { if (req.action === 'act') return { approved: true, receiptId: `permit-${identity.jobId}`, jobId: identity.jobId, threadId: scope.thread_id, epoch: req.epoch, observationId: req.observationId, actionDigest: identity.actionDigest!, expiresAt: Date.now() + 30_000 }; }, ...extra };
  const executor = new ComputerEdgeExecutor(options);
  return { db, transport, state, d, options, executor, counts: () => ({ captures, acts, renews }), async observe(id = 'observe') { transport.queue.push(command(id, { action: 'observe', epoch })); await executor.runOnce(); const output = JSON.parse(transport.finished.at(-1)!.result.output!); return JSON.parse(output._morphz_tool_result.text) as { observationId: string; epoch: number }; }, async close() { await executor.close(); db.close(); } };
}

test('existing Edge connection proof, pairing and manifest templates do no I/O', () => {
  assert.equal(Buffer.from(computerConnectionProof('node', 'challenge', 'nonce')).toString(), 'morphz-edge-connect-v1\0node\0challenge\0nonce');
  const pairing = computerPairingRequest({ code: 'user-provided-once', nodeId: binding.nodeId, name: 'test', publicKeyHex: '11'.repeat(32) });
  assert.deepEqual(pairing.capabilities, [COMPUTER_TOOL]); assert.equal(pairing.protocol_version, 1);
  assert.equal(pairing.device_key_fingerprint, `sha256:${createHash('sha256').update(Buffer.from('11'.repeat(32), 'hex')).digest('hex')}`);
  const manifest = computerHostManifest(binding, 'http://127.0.0.1:3210/host-disabled', 'x'.repeat(64));
  assert.deepEqual(manifest.tools[0].context_ids, [binding.contextId]); assert.equal(manifest.tools[0].definition.name, COMPUTER_TOOL);
  assert.throws(() => computerHostManifest(binding, 'http://remote:3210/', 'x'.repeat(64)));
  for (const raw of [{ action: 'act', epoch: 7, observationId: '00000000-0000-0000-0000-000000000000', operation: { type: 'shell', command: 'bad' } }, { action: 'observe', epoch: 7, principalId: 'other' }, { action: 'act', epoch: 7, observationId: '00000000-0000-0000-0000-000000000000', operation: { type: 'type', text: 'hello\nsubmit' } }]) assert.throws(() => parseComputerRequest(JSON.stringify(raw)));
});

test('client uses exact challenge/connect, bearer-header claim/heartbeat/finish, narrow capabilities', async () => {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  let native = command('wire-job', { action: 'status' }); let signed = '';
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); const body = JSON.parse(String(init?.body)); calls.push({ url: path, body, headers: new Headers(init?.headers) });
    assert.equal(init?.redirect, 'error');
    if (path.endsWith('/challenge')) return Response.json({ challenge_id: 'challenge', nonce: 'nonce', expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (path.endsWith('/connect')) return Response.json({ token: 'private-connection-token', expires_at: new Date(Date.now() + 900_000).toISOString() });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-connection-token'); assert.ok(!path.includes('token'));
    if (path.endsWith('/nodes/node-test/heartbeat')) { assert.deepEqual(body.capabilities, [COMPUTER_TOOL]); assert.deepEqual(body.targets[0].capabilities, [COMPUTER_TOOL]); return Response.json({ id: binding.nodeId, owner_principal_id: binding.principalId, status: 'online' }); }
    if (path.includes('/claim?')) return Response.json({ job: native });
    if (path.endsWith('/heartbeat')) { native = { ...native, revision: native.revision + 1 }; return Response.json(native); }
    if (path.endsWith('/finish')) { native = { ...native, status: body.status, revision: native.revision + 1 }; return Response.json(native); }
    throw new Error('unexpected');
  };
  const client = new ComputerEdgeClient({ baseUrl: 'http://127.0.0.1:3456', binding, workerId, fetch: fetcher, signConnectionProof: async b => { signed = Buffer.from(b).toString(); return 'aa'.repeat(64); } });
  assert.equal(calls.length, 0); await client.heartbeatNode(); const c = (await client.claim())!; const heart = await client.heartbeat(c, true);
  const { arguments: text, ...withoutArgs } = heart;
  await client.finish({ ...withoutArgs, argumentsHash: createHash('sha256').update(text).digest('hex') }, { status: 'succeeded', output: '{}', error: null });
  assert.equal(signed, 'morphz-edge-connect-v1\0node-test\0challenge\0nonce');
  assert.equal(calls.filter(c => c.url.endsWith('/connect')).length, 1);
  assert.deepEqual(calls.find(c => c.url.includes('/claim?'))!.body, { worker_id: workerId, lease_seconds: 30 });
  assert.equal(calls.at(-2)!.body.side_effect_started, true); assert.equal(calls.at(-1)!.body.claim_token, 'claim-test'); client.close();
});

test('client errors are redacted, bounds response and closes pending I/O', async () => {
  let secretReads = 0;
  const client = new ComputerEdgeClient({ baseUrl: 'http://127.0.0.1:3456', binding, workerId, signConnectionProof: async () => 'aa'.repeat(64), fetch: async () => { secretReads++; return new Response('credential-sensitive-data', { status: 403 }); } });
  await assert.rejects(client.claim(), e => e instanceof ComputerEdgeError && e.message === 'edge_http_403'); assert.equal(secretReads, 1); client.close();
  const large = new ComputerEdgeClient({ baseUrl: 'http://127.0.0.1:3456', binding, workerId, signConnectionProof: async () => 'aa'.repeat(64), fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(large.claim(), /edge_response_too_large/); large.close();
  const pending = new ComputerEdgeClient({ baseUrl: 'http://127.0.0.1:3456', binding, workerId, signConnectionProof: async () => 'aa'.repeat(64), fetch: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const p = pending.claim(); pending.close(); await assert.rejects(p, /edge_request_aborted/);
});

test('observe emits real native attachment; exact approved single-use act persists no text', async () => {
  const f = fixture(); try {
    const observed = await f.observe();
    const wire = JSON.parse(f.transport.finished[0].result.output!)._morphz_tool_result;
    assert.equal(wire.version, 1); assert.equal(wire.model_attachments[0].media_type, 'image/png'); assert.deepEqual(Buffer.from(wire.model_attachments[0].data_base64, 'base64'), pixel);
    assert.deepEqual(f.executor.approvalObservation(observed.observationId, 'thread-test', epoch).png, pixel);
    const secretText = 'private typed fixture value';
    const act = { action: 'act', epoch, observationId: observed.observationId, operation: { type: 'type', text: secretText } };
    f.transport.queue.push(command('act', act)); assert.equal((await f.executor.runOnce())?.state, 'dispatched'); assert.equal(f.counts().acts, 1);
    const rows = JSON.stringify(f.db.prepare('SELECT * FROM computer_edge_journal').all()); assert.ok(!rows.includes(secretText)); assert.ok(!rows.includes('"arguments":'));
    f.transport.queue.push(command('duplicate-observation', act)); assert.equal((await f.executor.runOnce())?.state, 'rejected'); assert.equal(f.counts().acts, 1);
  } finally { await f.close(); }
});

test('wrong identity, capability, provider, policy and raw commands never reach driver', async () => {
  const f = fixture(); try {
    for (const change of [(c:ComputerEdgeCommand)=>c.route.execution_scope.session_id='other', (c:ComputerEdgeCommand)=>c.route.execution_scope.principal_id='other', (c:ComputerEdgeCommand)=>c.tool_name='exec', (c:ComputerEdgeCommand)=>c.provider_node_id='other', (c:ComputerEdgeCommand)=>c.route.policy_digest='other']) {
      const c=command('bad', {action:'status'}); change(c); f.transport.queue.push(c); await assert.rejects(f.executor.runOnce(), /scope_mismatch/);
    }
    f.transport.queue.push(command('raw', { action: 'eval', code: 'raw' })); assert.equal((await f.executor.runOnce())?.state, 'rejected'); assert.equal(f.counts().captures + f.counts().acts, 0);
  } finally { await f.close(); }
});

test('cross-Thread, stale epoch, expired and replacement-display observations reject', async () => {
  const f = fixture(); try {
    const observed=await f.observe(); const req={action:'act',epoch,observationId:observed.observationId,operation:{type:'move',x:0,y:0}};
    f.transport.queue.push(command('other-thread',req,'other-thread')); assert.equal((await f.executor.runOnce())?.state,'rejected');
    f.transport.queue.push(command('old-epoch',{...req,epoch:6})); assert.equal((await f.executor.runOnce())?.state,'rejected');
    f.d.id='new-display'; f.transport.queue.push(command('display-replaced',req)); assert.equal((await f.executor.runOnce())?.state,'rejected');
    f.d.id='display-test'; f.db.prepare('UPDATE computer_edge_observations SET expires_at=0').run(); f.transport.queue.push(command('expired',req)); assert.equal((await f.executor.runOnce())?.state,'rejected');
    assert.equal(f.counts().acts,0);
  } finally { await f.close(); }
});

test('missing and mismatched effect permits reject without dispatch', async () => {
  const f=fixture(); try {
    const o=await f.observe(); f.options.authorize=async()=>undefined;
    f.transport.queue.push(command('missing-permit',{action:'act',epoch,observationId:o.observationId,operation:{type:'key',key:'Enter'}}));
    assert.equal((await f.executor.runOnce())?.state,'rejected'); assert.match(f.transport.finished.at(-1)!.result.error!,/approval_required/); assert.equal(f.counts().acts,0);
    f.options.authorize=async(scope,req,i)=>({approved:true,receiptId:'permit',jobId:'wrong',threadId:scope.thread_id,epoch,observationId:o.observationId,actionDigest:i.actionDigest!,expiresAt:Date.now()+1000});
    f.transport.queue.push(command('wrong-permit',{action:'act',epoch,observationId:o.observationId,operation:{type:'key',key:'Enter'}})); assert.equal((await f.executor.runOnce())?.state,'rejected'); assert.equal(f.counts().acts,0);
  } finally { await f.close(); }
});

test('pending approval keeps native lease alive, aborts on deadline, emits no input', async () => {
  const f=fixture({authorizationTimeoutMs:160,heartbeatIntervalMs:50}); try {
    const o=await f.observe(); let aborted=false;
    f.options.authorize=async(_scope,req,i)=>{if(req.action!=='act')return;return new Promise(()=>{i.signal.addEventListener('abort',()=>{aborted=true;},{once:true});});};
    f.transport.beats=[]; f.transport.queue.push(command('waiting-approval',{action:'act',epoch,observationId:o.observationId,operation:{type:'key',key:'Enter'}}));
    assert.equal((await f.executor.runOnce())?.state,'rejected'); assert.equal(aborted,true); assert.ok(f.transport.beats.length>=2); assert.ok(f.transport.beats.every(v=>v===false)); assert.equal(f.counts().acts,0);
  } finally { await f.close(); }
});

test('takeover during native side-effect acknowledgment rejects stale plan without revoking new owner', async () => {
  const f=fixture(); try {
    const o=await f.observe(); f.transport.beforeBeat=async(c,effect)=>{assert.equal(effect,true); f.state.owner='human'; f.state.epoch++; return {...c,revision:c.revision+1};};
    f.transport.queue.push(command('takeover-race',{action:'act',epoch,observationId:o.observationId,operation:{type:'move',x:0,y:0}}));
    assert.equal((await f.executor.runOnce())?.state,'rejected'); assert.equal(f.counts().acts,0); assert.equal(f.state.owner,'human');
  } finally { await f.close(); }
});

test('revocation between bounded gestures becomes unknown and preserves newer human owner', async () => {
  const f=fixture(); try {
    const o=await f.observe(); let emitted=0;
    f.options.driver.act=async(_op,c)=>{c.assertCurrent(); emitted++; f.state.owner='human';f.state.epoch++;c.assertCurrent();emitted++;};
    f.transport.queue.push(command('partial',{action:'act',epoch,observationId:o.observationId,operation:{type:'type',text:'two events'}}));
    assert.equal((await f.executor.runOnce())?.state,'unknown'); assert.equal(emitted,1); assert.equal(f.state.owner,'human'); assert.equal(f.state.uncertainty,true);
  } finally { await f.close(); }
});

test('lost finish response retries only the saved envelope; changed job content conflicts', async () => {
  const f=fixture(); try {
    const o=await f.observe(); f.transport.failFinish=true;
    const c=command('lost-finish',{action:'act',epoch,observationId:o.observationId,operation:{type:'move',x:0,y:0}});
    f.transport.queue.push(c); const r=await f.executor.runOnce(); assert.equal(r?.delivered,false); const saved=structuredClone(f.transport.finished.at(-1));
    f.transport.failFinish=false; assert.equal((await f.executor.retryFinish(c.job_id)).delivered,true); assert.deepEqual(f.transport.finished.at(-1),saved); assert.equal(f.counts().acts,1);
    f.transport.queue.push({...c,arguments:JSON.stringify({action:'status'})}); await assert.rejects(f.executor.runOnce(),/content_conflict/); assert.equal(f.counts().acts,1);
  } finally { await f.close(); }
});

test('driver secrets are redacted; restart interrupted journal never replays input', async () => {
  const f=fixture(); try {
    const o=await f.observe(); f.options.driver.act=async()=>{throw new Error('argv text=secret-password stderr=private');};
    const c=command('driver-error',{action:'act',epoch,observationId:o.observationId,operation:{type:'type',text:'secret-password'}});
    f.transport.queue.push(c); assert.equal((await f.executor.runOnce())?.state,'unknown'); assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM computer_edge_journal').all()).includes('secret-password'));
    f.db.prepare("UPDATE computer_edge_journal SET state='running',delivered=0 WHERE job_id=?").run(c.job_id);
    const again=new ComputerEdgeExecutor(f.options); f.transport.queue.push(c); const before=f.counts().acts; assert.equal((await again.runOnce())?.state,'unknown'); assert.equal(f.counts().acts,before); assert.equal(f.state.owner,'paused'); assert.equal(f.state.uncertainty,true); await again.close();
  } finally { await f.close(); }
});

test('retention expiry erases screenshot retry payload and never reobserves old job', async () => {
  let now=Date.now(); const f=fixture({now:()=>now}); try {
    // Capture timestamp must agree with the injected clock.
    f.options.driver.capture=async c=>{c.assertCurrent();return {...f.d,png:pixel,capturedAt:now};};
    f.transport.failFinish=true; await f.observe(); now+=COMPUTER_EDGE_LIMITS.resultRetentionMs+1;
    await assert.rejects(f.executor.retryFinish('observe'),/result_expired/);
    const row=f.db.prepare('SELECT finish_json,lease_json FROM computer_edge_journal WHERE job_id=?').get('observe'); assert.equal(row!.finish_json,null);assert.equal(row!.lease_json,null);
  } finally { await f.close(); }
});


test('native heartbeat identity corruption and revoked retry authority fail closed', async () => {
  const f=fixture(); try {
    const o=await f.observe(); f.transport.beforeBeat=async(c)=>({...c,job_id:'different-job',revision:c.revision+1});
    f.transport.queue.push(command('corrupt-heartbeat',{action:'act',epoch,observationId:o.observationId,operation:{type:'move',x:0,y:0}}));
    assert.equal((await f.executor.runOnce())?.state,'rejected'); assert.equal(f.counts().acts,0);
    assert.equal(f.transport.finished.at(-1)!.command.job_id,'corrupt-heartbeat');
    f.transport.beforeBeat=undefined; f.transport.failFinish=true; f.transport.queue.push(command('unconfirmed-read',{action:'status'})); await f.executor.runOnce();
    const prior=f.transport.finished.length; f.transport.failFinish=false; f.options.authorize=async()=>{throw new Error('current authority revoked');};
    assert.equal((await f.executor.retryFinish('unconfirmed-read')).delivered,false); assert.equal(f.transport.finished.length,prior);
  } finally {await f.close();}
});

test('close aborts pending authorization and never dispatches; malformed image is rejected', async () => {
  const f=fixture(); const o=await f.observe(); let entered!:()=>void; const ready=new Promise<void>(r=>{entered=r;});
  f.options.authorize=async(_s,req,i)=>{if(req.action!=='act')return;entered();return new Promise((_r,reject)=>i.signal.addEventListener('abort',()=>reject(new Error('closed private detail')),{once:true}));};
  f.transport.queue.push(command('close-pending',{action:'act',epoch,observationId:o.observationId,operation:{type:'key',key:'Ctrl+L'}}));
  const running=f.executor.runOnce();await ready;await f.executor.close();await running;assert.equal(f.counts().acts,0);f.db.close();
  const bad=fixture();try{bad.options.driver.capture=async()=>({...bad.d,png:Buffer.from('not a PNG'),capturedAt:Date.now()});bad.transport.queue.push(command('bad-png',{action:'observe',epoch}));assert.equal((await bad.executor.runOnce())?.state,'unknown');assert.equal(bad.transport.finished.at(-1)!.result.output,null);}finally{await bad.close();}
});
