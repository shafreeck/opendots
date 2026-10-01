import test from 'node:test';
import assert from 'node:assert/strict';
import { MorphzAdapter, MorphzError } from '../src/morphz-adapter.ts';

const capabilities = { enabled: true, io_versions: ['1'], encodings: ['json'], formats: [{ definition: { id: 'morphz.chat', version: '1', encodings: ['json', 'utf8'] } }] };
function mock(responses: Array<unknown | Response>) {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers; body: any }> = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    assert.ok(responses.length, 'Unexpected HTTP call');
    const response = responses.shift();
    return response instanceof Response ? response : Response.json(response);
  }) as typeof fetch;
  return { calls, adapter: new MorphzAdapter({ baseUrl: 'https://morphz.example', principalId: 'local-user', serviceToken: 'test-only-token', fetch: fetcher }) };
}

test('typed message checks capabilities then sends the exact v1 chat envelope', async () => {
  const receipt = { io_version: '1', status: 'accepted', accepted: true, message_id: 'input-1', event_id: 'input-1', session_id: 'session/a', cursor: 'opaque-admission', binding: {} };
  const { adapter, calls } = mock([capabilities, receipt, receipt]);
  const result = await adapter.sendMessage('session/a', 'Research this', 'client-stable-id');
  assert.deepEqual(result, receipt);
  assert.equal(result.status, 'accepted'); // Never rename acceptance to completion.
  assert.equal(calls[0].url, 'https://morphz.example/api/session-io/capabilities');
  assert.equal(calls[1].url, 'https://morphz.example/api/sessions/session%2Fa/io/messages');
  assert.deepEqual(calls[1].body, {
    io_version: '1', client_message_id: 'client-stable-id',
    message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: 'Research this' } } },
    activation: { dispatch_mode: 'parallel' },
  });
  await adapter.sendMessage('session/a', 'Research this', 'client-stable-id');
  assert.deepEqual(calls[1].body, calls[2].body);
  for (const call of calls) {
    assert.equal(call.headers.get('x-morphz-principal'), 'local-user');
    assert.equal(call.headers.get('authorization'), 'Bearer test-only-token');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.ok(!call.url.includes('token'));
  }
});

test('history preserves opaque session-bound cursors and does not decode or fabricate them', async () => {
  const page = { subscription: { io_version: '1' }, events: [{ event_id: 'output-1', sequence: 19, type: 'output.committed' }], cursor: 'opaque-next' };
  const { adapter, calls } = mock([capabilities, page]);
  assert.deepEqual(await adapter.listEvents('session-a', 'opaque/+?=cursor'), page);
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, '/api/sessions/session-a/io/events');
  assert.equal(url.searchParams.get('after'), 'opaque/+?=cursor');
  assert.equal(url.searchParams.get('io_version'), '1');
  assert.equal(url.searchParams.get('after_sequence'), null);
  assert.equal(url.searchParams.get('receive_unknown'), 'reject');
  assert.deepEqual(JSON.parse(url.searchParams.get('receive_formats')!), [{ id: 'morphz.chat', version: '1', encoding: 'json' }]);
});

test('session and objective creation use observed routes, runtime owns objective execution', async () => {
  const { adapter, calls } = mock([{ id: 'session-a' }, { objective: { id: 'objective-a' }, harness_binding: null }]);
  await adapter.createSession({ id: 'session-a', title: 'Inbox', mount: { type: 'new_blank_context' } });
  assert.equal(calls[0].url, 'https://morphz.example/api/sessions');
  assert.equal(calls[0].body.mount.type, 'new_blank_context');
  const input = { id: 'objective-a', coordinator_session_id: 'session-a', delivery_session_id: 'session-a', stated_objective: 'Prepare a summary' };
  const result = await adapter.createObjective(input);
  assert.equal(calls[1].url, 'https://morphz.example/api/objectives');
  assert.deepEqual(calls[1].body, input);
  assert.equal(result.objective.id, 'objective-a');
});

test('real approval decisions retain the service revision check', async () => {
  const { adapter, calls } = mock([{ approvals: [], truncated: false }, { id: 'approval/a', status: 'allowed', revision: 2 }]);
  await adapter.listApprovals('session-a');
  await adapter.decideApproval('session-a', 'approval/a', { expected_revision: 1, decision: 'allow_once' });
  assert.equal(calls[1].url, 'https://morphz.example/api/sessions/session-a/approvals/approval%2Fa');
  assert.deepEqual(calls[1].body, { expected_revision: 1, decision: 'allow_once' });
});

test('unsupported capability fails closed before submitting a message', async () => {
  const { adapter, calls } = mock([{ ...capabilities, io_versions: ['2'] }]);
  await assert.rejects(adapter.sendMessage('s', 'hello', 'stable-id'), /does not advertise/);
  assert.equal(calls.length, 1);
});

test('HTTP errors expose status and a bounded code, never upstream sensitive text', async () => {
  const { adapter } = mock([Response.json({ error: { code: 'idempotency_conflict', message: 'private prompt and token' } }, { status: 409 })]);
  await assert.rejects(adapter.getCapabilities(), error => error instanceof MorphzError && error.status === 409 && error.code === 'idempotency_conflict' && !error.message.includes('private'));
});

test('server-only adapter rejects unsafe base URLs and blank principals', () => {
  for (const baseUrl of ['http://remote.example', 'https://u:p@example.com', 'https://example.com?token=x', 'https://example.com/subpath']) {
    assert.throws(() => new MorphzAdapter({ baseUrl, principalId: 'user' }));
  }
  assert.throws(() => new MorphzAdapter({ baseUrl: 'http://127.0.0.1:8000', principalId: '' }));
  assert.doesNotThrow(() => new MorphzAdapter({ baseUrl: 'http://127.0.0.1:8000', principalId: 'user' }));
});
