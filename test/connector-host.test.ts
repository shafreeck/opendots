import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorHost, connectorHostRegistration } from '../src/connector-host.ts';
import { CONNECTOR_TOOL, ConnectorError, type ConnectorAdapter, type ConnectorEnvelope, type Json } from '../src/connector-types.ts';
const token = 't'.repeat(64), authorization = `Bearer ${token}`;
const binding = { principalId: 'principal', agentId: 'agent', contextId: 'context', sessionId: 'session' };
const envelope = (args: ConnectorEnvelope['arguments'] = { action: 'call', connector: 'test_public', operation: 'read', parameters: { repository: 'public/repo' } }): ConnectorEnvelope => ({ protocol: 1, tool: CONNECTOR_TOOL, invocation: { job_id: 'job', tool_call_id: 'call', thread_id: 'thread', target_id: 'target-default', principal_id: 'principal', agent_id: 'agent', context_id: 'context', session_id: 'session' }, arguments: args });
function fixture(execute: () => Promise<Json> = async () => ({ value: 'public' })) {
  const db = new DatabaseSync(':memory:'); let calls = 0, authorizationCalls = 0; let permitted = true; const verifications: boolean[] = [];
  const adapter: ConnectorAdapter = { id: 'test_public', label: 'Test public adapter', operations: [{ id: 'read', description: 'Fixture', effect: 'public_read', inputSchema: { type: 'object' } }], status: () => ({ accountConnected: false }), validate: (_operation, args) => args as Record<string, Json>, call: async () => { calls++; return execute(); } };
  const options = { db, token, runtime: { binding, verifyInvocation: async (_envelope: ConnectorEnvelope, replay: boolean) => { verifications.push(replay); } }, adapters: [adapter], authorize: async () => { authorizationCalls++; if (!permitted) throw Error('SECRET_PERMISSION_DETAIL'); } };
  const host = new ConnectorHost(options);
  return { db, host, options, adapter, verifications, calls: () => calls, authorizationCalls: () => authorizationCalls, deny: () => { permitted = false; } };
}
test('exact native call receipts deduplicate and preserve the same identity across host reopen', async () => {
  const f = fixture(); try {
    const first = await f.host.handle(authorization, envelope()); const again = await f.host.handle(authorization, envelope());
    assert.equal(first.status, 'succeeded'); assert.equal(first.replayed, false); assert.equal(again.replayed, true); assert.equal(first.id, again.id); assert.equal(f.calls(), 1);
    const reopened = new ConnectorHost(f.options); const after = await reopened.handle(authorization, envelope()); assert.equal(after.id, first.id); assert.equal(f.calls(), 1);
    assert.deepEqual(f.verifications, [false,true,true]); assert.equal(f.authorizationCalls(), 6);
    const row = f.db.prepare('SELECT * FROM connector_receipts').get()!; assert.ok(!JSON.stringify(row).includes('public/repo'), 'Only parameter hash, not raw arguments, is journalled'); reopened.close();
  } finally { f.host.close(); f.db.close(); }
});
test('callback authentication/schema/binding and changed arguments reject before dispatch', async () => {
  const f = fixture(); try {
    await assert.rejects(f.host.handle('Bearer wrong', envelope()), ConnectorError);
    await assert.rejects(f.host.handle(authorization, { ...envelope(), token: 'extra' }), ConnectorError);
    await assert.rejects(f.host.handle(authorization, { ...envelope(), invocation: { ...envelope().invocation, target_id: 'desktop' } }), ConnectorError);
    await assert.rejects(f.host.handle(authorization, envelope({ action: 'call', connector: 'test_public', operation: 'write', parameters: {} })), ConnectorError);
    assert.equal(f.calls(), 0); await f.host.handle(authorization, envelope());
    await assert.rejects(f.host.handle(authorization, envelope({ action: 'call', connector: 'test_public', operation: 'read', parameters: { repository: 'changed' } })), e => e instanceof ConnectorError && e.code === 'connector_receipt_conflict'); assert.equal(f.calls(), 1);
  } finally { f.host.close(); f.db.close(); }
});
test('revocation denies receipt replay; native proof and server policy are mandatory', async () => {
  const f = fixture(); try {
    await f.host.handle(authorization, envelope()); f.deny();
    await assert.rejects(f.host.handle(authorization, envelope()), e => e instanceof ConnectorError && e.code === 'connector_permission_denied' && !e.message.includes('SECRET')); assert.equal(f.calls(), 1);
    assert.throws(() => new ConnectorHost({ ...f.options, authorize: undefined as any }), ConnectorError);
    assert.throws(() => new ConnectorHost({ ...f.options, adapters: [{ ...f.adapter, operations: [{ ...f.adapter.operations[0]!, effect: 'write' as any }] }] }), ConnectorError);
  } finally { f.host.close(); f.db.close(); }
});
test('concurrent duplicate does not emit again while original dispatch is in progress', async () => {
  let finish!: (value: Json) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const first = f.host.handle(authorization, envelope()); await new Promise(setImmediate);
    const concurrent = await f.host.handle(authorization, envelope()); assert.equal(concurrent.status, 'unknown'); assert.equal(concurrent.replayed, true); assert.equal(f.calls(), 1);
    finish({ done: true }); assert.equal((await first).status, 'succeeded'); assert.equal((await f.host.handle(authorization, envelope())).status, 'succeeded');
  } finally { f.host.close(); f.db.close(); }
});
test('policy revocation during native proof is rechecked before any provider call', async () => {
  const f = fixture(); let resolveProof!: () => void;
  const host = new ConnectorHost({ ...f.options, runtime: { binding, verifyInvocation: async () => new Promise<void>(resolve => { resolveProof = resolve; }) } });
  try {
    const pending = host.handle(authorization, envelope()); await new Promise(setImmediate); f.deny(); resolveProof();
    await assert.rejects(pending, e => e instanceof ConnectorError && e.code === 'connector_permission_denied');
    assert.equal(f.calls(), 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM connector_receipts').get()!.n, 0);
  } finally { host.close(); f.host.close(); f.db.close(); }
});
test('host deadline aborts a dispatched call, then ignores late success', async () => {
  const f = fixture(async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { late: true }; });
  const host = new ConnectorHost({ ...f.options, timeoutMs: 10 });
  try {
    const result = await host.handle(authorization, envelope()); assert.equal(result.status, 'unknown');
    await new Promise(resolve => setTimeout(resolve, 50));
    const retry = await host.handle(authorization, envelope()); assert.equal(retry.status, 'unknown'); assert.equal(f.calls(), 1);
  } finally { host.close(); f.host.close(); f.db.close(); }
});
test('interrupted/failed call stays unknown without raw errors or automatic replay', async () => {
  const f = fixture(async () => { throw Error('Authorization Bearer SECRET_AND_URL'); });
  try {
    const result = await f.host.handle(authorization, envelope()); assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes('SECRET'));
    const after = await new ConnectorHost(f.options).handle(authorization, envelope()); assert.equal(after.status, 'unknown'); assert.equal(f.calls(), 1);
  } finally { f.host.close(); f.db.close(); }
});
test('shutdown aborts waiting dispatch and later completion cannot rewrite unknown receipt', async () => {
  let finish!: (value: Json) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const first = f.host.handle(authorization, envelope()); await new Promise(setImmediate); f.host.close();
    assert.equal((await first).status, 'unknown'); finish({ tooLate: true }); await new Promise(setImmediate);
    const row = f.db.prepare('SELECT state,result_json FROM connector_receipts').get()!; assert.equal(row.state, 'unknown'); assert.equal(row.result_json, null);
    await assert.rejects(f.host.handle(authorization, envelope()), ConnectorError);
  } finally { f.host.close(); f.db.close(); }
});
test('discovery/status also requires a native invocation and emits no provider call', async () => {
  const f = fixture(); try {
    const result = await f.host.handle(authorization, envelope({ action: 'list' })); assert.equal(result.status, 'succeeded'); assert.equal(f.calls(), 0); assert.equal(f.verifications.length, 1);
    assert.equal((result.result as any).nativeRegistrationVerified, false);
    const entry = connectorHostRegistration({ contextId: binding.contextId, endpoint: 'http://127.0.0.1:4321/api/host-tools/call', token });
    assert.equal(entry.definition.name, CONNECTOR_TOOL); assert.deepEqual(entry.context_ids, ['context']); assert.deepEqual(entry.idempotent_requests, []);
    for (const endpoint of ['https://remote.example','http://localhost:1234','http://127.0.0.1:1234?secret=x']) assert.throws(() => connectorHostRegistration({ contextId: 'context', endpoint, token }), ConnectorError);
  } finally { f.host.close(); f.db.close(); }
});
