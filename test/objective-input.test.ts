import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectiveInput } from '../src/objective-input.ts';
import { LocalOperatorAdapter, MorphzError, type RuntimeObjective } from '../src/morphz-adapter.ts';
const binding = { agentId: 'agent-1', contextId: 'context-1', sessionId: 'session-1', principalId: 'principal-1' };
const objective = (extra: Partial<RuntimeObjective> = {}): RuntimeObjective => ({ id: 'objective-1', agent_id: binding.agentId, context_id: binding.contextId, coordinator_session_id: binding.sessionId, delivery_session_id: binding.sessionId, initiating_principal_id: binding.principalId, stated_objective: 'Original task', status: 'active', revision: 8, generation: 2, ...extra });
const input = { text: 'Use the corrected file name', idempotencyKey: 'objective-input-001', expectedGeneration: 2 };

test('Objective supplement binds generation independently of ordinary revision changes and preserves waits', () => {
  const service = new ObjectiveInput(binding); const waiting = objective({ wait_condition: { kind: 'permission', request_id: 'approval-1' } });
  assert.equal(service.target(waiting).available, true); assert.equal(service.target(waiting).replyAvailable, false);
  const prepared = service.prepare(waiting, input); assert.deepEqual(prepared.destination, { kind: 'objective', objective_id: 'objective-1', generation: 2 });
  assert.deepEqual(service.prepare(objective({ revision: 100 }), input).destination, prepared.destination);
  assert.throws(() => service.prepare(objective({ generation: 3 }), input), (e: any) => e.status === 409 && e.code === 'objective_generation_changed');
});

test('foreign coordinator, Agent, Context or explicit Principal never become a directed target', () => {
  const service = new ObjectiveInput(binding);
  for (const change of [{ coordinator_session_id: 'other-session' }, { agent_id: 'other-agent' }, { context_id: 'other-context' }, { initiating_principal_id: 'other-principal' }]) assert.throws(() => service.target(objective(change)), (e: any) => e.status === 403);
  assert.throws(() => service.target(objective({ generation: 0 })), (e: any) => e.status === 502);
  // Native legacy null ownership remains bounded by saved Session authorization;
  // the host must reauthorize that route before invoking this pure validator.
  assert.equal(service.target(objective({ initiating_principal_id: null })).available, true);
});

test('paused, blocked, terminal and unknown Objective states cannot implicitly resume or create follow-up work', () => {
  const service = new ObjectiveInput(binding);
  for (const status of ['paused','blocked','completed','cancelled','failed','unknown']) {
    const current = objective({ status }); assert.equal(service.target(current).available, false); assert.throws(() => service.prepare(current, input), (e: any) => e.status === 409);
  }
  const waiting = objective({ status: 'active', wait_condition: { kind: 'user_input', session_id: binding.sessionId, request_id: 'question-2' } });
  assert.equal(service.target(waiting).replyRequestId, 'question-2'); assert.equal(service.target(waiting).available, true);
});

test('question IDs are source-exact but unseen question content disables explicit replies; supplements preserve waits', () => {
  const service = new ObjectiveInput(binding); const waiting = objective({ wait_condition: { kind: 'user_input', session_id: binding.sessionId, request_id: 'question-2' } });
  assert.equal(service.prepare(waiting, input).destination.reply_to_request_id, undefined);
  assert.equal(service.target(waiting).replyAvailable, false); assert.equal(service.target(waiting).questionText, null); assert.equal(service.target(waiting).replyReason, 'question_text_unavailable');
  assert.throws(() => service.prepare(waiting, { ...input, replyToRequestId: 'question-2' }), (e: any) => e.code === 'objective_question_text_unavailable');
  assert.throws(() => service.prepare(waiting, { ...input, replyToRequestId: 'question-1' }), (e: any) => e.code === 'objective_question_changed');
  const legacy = objective({ wait_condition: { kind: 'user_input', session_id: binding.sessionId } }); assert.equal(service.target(legacy).replyRequestId, 'legacy:objective-1:2:8');
  assert.throws(() => service.prepare(objective({ ...legacy, revision: 9 }), { ...input, replyToRequestId: 'legacy:objective-1:2:8' }), (e: any) => e.code === 'objective_question_changed');
  for (const wait of [{ kind: 'user_input', session_id: 'foreign-session', request_id: 'question-2' }, { kind: 'user_input', session_id: binding.sessionId, request_id: 123 }, { kind: 'timer', deadline: new Date().toISOString() }]) assert.equal(service.target(objective({ wait_condition: wait })).replyAvailable, false);
});

test('Objective input shape does not accept browser routing, model or permission overrides', () => {
  const service = new ObjectiveInput(binding);
  for (const extra of [{ input_destination: { kind: 'thread' } }, { dispatch_mode: 'interrupt' }, { model_alias: 'other' }, { expectedRevision: 8 }, { principalId: 'other' }]) assert.throws(() => service.prepare(objective(), { ...input, ...extra }), (e: any) => e.status === 400);
});

test('adapter sends exact typed Objective destination with parallel dispatch and no global interruption or route override', async () => {
  const calls: any[] = []; const capabilities = { enabled: true, directed_input: true, io_versions: ['1'], encodings: ['json'], formats: [{ definition: { id: 'morphz.chat', version: '1', encodings: ['json'] } }] };
  const adapter = new LocalOperatorAdapter({ baseUrl: 'http://127.0.0.1:3001', operatorToken: 'synthetic-token', fetch: (async (url, init) => { const call = { url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null }; calls.push(call); return Response.json(call.body ? { io_version: '1', accepted: true, status: 'accepted', event_id: 'input-1', message_id: 'input-1', session_id: 'session-1', cursor: 'opaque', binding: {} } : capabilities); }) as typeof fetch });
  const destination = { kind: 'objective' as const, objective_id: 'objective-1', generation: 2, reply_to_request_id: 'question-2' };
  await adapter.sendObjectiveInput('session-1', input.text, 'stable-command', destination); await adapter.sendObjectiveInput('session-1', input.text, 'stable-command', destination);
  assert.deepEqual(calls[1].body, calls[2].body); assert.deepEqual(calls[1].body.activation, { mode: 'evaluate', dispatch_mode: 'parallel', input_destination: destination });
  assert.equal(calls[1].body.client_message_id, 'stable-command'); assert.equal(calls[1].body.message.content.value.text, input.text); assert.equal(calls[1].headers.get('authorization'), 'Bearer synthetic-token');
  const unsupported = new LocalOperatorAdapter({ baseUrl: 'http://127.0.0.1:3001', fetch: (async () => Response.json({ ...capabilities, directed_input: false })) as typeof fetch });
  await assert.rejects(unsupported.sendObjectiveInput('s', 'text', 'same-command', destination), e => e instanceof MorphzError && e.code === 'directed_input_unavailable');
  await assert.rejects(adapter.sendObjectiveInput('s', 'text', 'same-command', { ...destination, kind: 'thread' } as any), /Objective input destination/);
});
