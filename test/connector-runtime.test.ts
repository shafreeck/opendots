import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorRuntimeClient } from '../src/connector-runtime.ts';
import { CONNECTOR_TOOL, ConnectorError, type ConnectorEnvelope } from '../src/connector-types.ts';
const binding = { principalId: 'principal', agentId: 'agent', contextId: 'context', sessionId: 'session' };
const envelope: ConnectorEnvelope = { protocol: 1, tool: CONNECTOR_TOOL, invocation: { job_id: 'job', tool_call_id: 'call', thread_id: 'thread', target_id: 'target-default', principal_id: 'principal', agent_id: 'agent', context_id: 'context', session_id: 'session' }, arguments: { action: 'list' } };
function records() {
  return {
    job: { id: 'job', tool_call_id: 'call', tool_name: CONNECTOR_TOOL, thread_id: 'thread', target_id: 'target-default', initiating_principal_id: 'principal', agent_id: 'agent', context_id: 'context', session_id: 'session', status: 'running', cancel_requested_at: null, request: { action: 'list', _morphz_execution_route: { target_id: 'target-default', backend_kind: 'in_process_local' }, _morphz_wake_thread: false } },
    thread: { id: 'thread', initiating_principal_id: 'principal', agent_id: 'agent', context_id: 'context', session_id: 'session', target_id: 'target-default', lifecycle: 'open', control_state: 'active' },
  };
}
function fixture(change?: (r: ReturnType<typeof records>) => void) {
  const r = records(); change?.(r); const calls: string[] = [];
  const client = new ConnectorRuntimeClient({ baseUrl: 'http://127.0.0.1:1234', binding, operatorToken: 'TEST_TOKEN', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('x-morphz-principal'), null);
    if (path === '/api/execution-jobs/job') return Response.json(r.job);
    if (path === '/api/contexts/context/threads/thread') return Response.json({ snapshot: { thread: r.thread } });
    if (path.endsWith('/principal')) return Response.json({ principal_id: 'principal', context_id: 'context', session_id: 'session' });
    return Response.json({ id: 'session', agent_id: 'agent', context_id: 'context' });
  } }); return { client, calls };
}
test('source-pinned native Job/Thread/Session/Principal proof uses four fixed read APIs', async () => {
  const { client, calls } = fixture(); await client.verifyInvocation(envelope, false); assert.equal(calls.length, 4);
});
test('new calls reject inactive/cancelled job, paused thread and wrong tool/arguments/identity', async () => {
  const mutations: Array<(r: ReturnType<typeof records>) => void> = [r => { r.job.status = 'succeeded'; }, r => { (r.job as any).cancel_requested_at = 'now'; }, r => { r.thread.control_state = 'paused'; }, r => { r.thread.lifecycle = 'completed'; }, r => { r.job.tool_name = 'other'; }, r => { r.job.request.action = 'call'; }, r => { r.job.initiating_principal_id = 'other'; }, r => { (r.job.request as any)._morphz_unknown = true; }, r => { r.job.request._morphz_execution_route.backend_kind = 'edge_node'; }];
  for (const mutate of mutations) await assert.rejects(fixture(mutate).client.verifyInvocation(envelope, false), ConnectorError);
});
test('receipt replay allows terminal history but still checks native payload and live identity', async () => {
  await fixture(r => { r.job.status = 'succeeded'; r.thread.lifecycle = 'completed'; }).client.verifyInvocation(envelope, true);
  await assert.rejects(fixture(r => { r.job.request.action = 'call'; }).client.verifyInvocation(envelope, true), ConnectorError);
  const { client, calls } = fixture(); await assert.rejects(client.verifyInvocation({ ...envelope, invocation: { ...envelope.invocation, principal_id: 'other' } }, true), ConnectorError); assert.equal(calls.length, 0);
});
test('catalogue exposes bounded declared capabilities without paths, schemas or connection claims', async () => {
  const client = new ConnectorRuntimeClient({ baseUrl: 'http://127.0.0.1:1234', binding, fetch: async () => Response.json({ targets: [{ id: 'target-default', revision: 1, kind: 'in_process_local', status: 'online', capabilities: ['exec','read','exec'], metadata: { secret: 'DO_NOT_EXPOSE' }, workspace_root: 'DO_NOT_EXPOSE' }] }) });
  const view = await client.catalogue(); assert.deepEqual(view.targets[0]!.capabilities, ['exec','read']); assert.equal(view.connectionVerified, false); assert.equal(view.schemasAvailable, false); assert.ok(!JSON.stringify(view).includes('DO_NOT_EXPOSE'));
});
test('local operator origin and malformed native response fail closed', async () => {
  for (const baseUrl of ['http://external.example','https://user:pass@localhost','http://localhost/path','http://localhost?token=SECRET']) assert.throws(() => new ConnectorRuntimeClient({ baseUrl, binding }), ConnectorError);
  const client = new ConnectorRuntimeClient({ baseUrl: 'http://localhost:12', binding, fetch: async () => { throw Error('Bearer SECRET'); } });
  await assert.rejects(client.catalogue(), e => e instanceof ConnectorError && !e.message.includes('SECRET'));
});
