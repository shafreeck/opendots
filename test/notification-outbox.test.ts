import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationOutbox, NotificationError } from '../src/notification-outbox.ts';
import type { IoEvent, RuntimeObjective, RuntimeApproval } from '../src/morphz-adapter.ts';

const binding = { userId: 'user-1', sessionId: 'session-1', contextId: 'context-1', agentId: 'agent-1' };
const event = (id = 'event-1', extra: Partial<IoEvent> = {}): IoEvent => ({ io_version: '1', type: 'output.committed', event_id: id, sequence: 1, session_id: binding.sessionId, timestamp: '2026-09-30T12:00:00Z', message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: 'private synthetic message' } } }, ...extra });
const approval = (rev = 1, status = 'pending_human', extra: Partial<RuntimeApproval> = {}): RuntimeApproval => ({ id: 'approval-1', revision: rev, status, ...extra });
const objective = (rev = 1, status = 'completed', extra: Partial<RuntimeObjective> = {}): RuntimeObjective => ({ id: 'objective-1', agent_id: binding.agentId, context_id: binding.contextId, coordinator_session_id: binding.sessionId, delivery_session_id: binding.sessionId, stated_objective: 'private synthetic prompt', status, revision: rev, generation: 1, ...extra });
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-notifications-')); const path = join(dir, 'product.db'); let now = 1000;
  let box = new NotificationOutbox(path, binding, () => now);
  t.after(() => { box.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get box() { return box; }, dir, path, setNow: (value: number) => { now = value; }, restart: () => { box.close(); box = new NotificationOutbox(path, binding, () => now); return box; } };
}

test('committed replies queue once, user read survives replay and restart, and drafts are never notices', t => {
  const f = fixture(t);
  const state = f.box.sync({ sessionId: binding.sessionId, events: [event('input', { type: 'input.accepted' }), event('draft', { type: 'output.text.delta' }), event()] });
  assert.equal(state.items.length, 1); assert.equal(state.unread, 1); assert.equal(state.delivery, 'local_inbox_only');
  assert.equal(state.items[0].sourceId, 'event-1'); assert.equal(state.items[0].sourceRevision, 1);
  const id = state.items[0].id; f.setNow(2000); f.box.acknowledge([id]); f.setNow(3000); f.box.acknowledge([id]);
  assert.equal(f.box.snapshot().items[0].readAt, 2000);
  f.restart().sync({ sessionId: binding.sessionId, events: [event()] });
  assert.equal(f.box.snapshot().items[0].id, id); assert.equal(f.box.snapshot().items[0].createdAt, 1000); assert.equal(f.box.snapshot().unread, 0);
});

test('notification storage holds provenance and generic labels without copying source bodies', t => {
  const f = fixture(t); const secret = 'SYNTHETIC_PRIVATE_NOTIFICATION_BODY_0930';
  const reply = event('safe-event', { message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: secret } } } });
  const state = f.box.sync({ sessionId: binding.sessionId, events: [reply], approvals: { items: [approval(1, 'pending_human', { action: { command: secret }, justification: secret })], complete: true }, objectives: [objective(1, 'completed', { stated_objective: secret })] });
  assert.equal(state.items.length, 3); assert.ok(!JSON.stringify(state).includes(secret));
  for (const name of readdirSync(f.dir)) assert.ok(!readFileSync(join(f.dir, name)).includes(Buffer.from(secret)), name);
});

test('scope violations and immutable rewriting roll back the whole notification batch', t => {
  const f = fixture(t);
  assert.throws(() => f.box.sync({ sessionId: 'other-session', events: [event()] }), NotificationError);
  assert.throws(() => f.box.sync({ sessionId: binding.sessionId, events: [event(), event('other', { session_id: 'other-session' })] }), /Session/);
  assert.equal(f.box.snapshot().total, 0);
  assert.throws(() => f.box.sync({ sessionId: binding.sessionId, events: [event()], approvals: { items: [approval(1, 'pending_human', { context_id: 'foreign-context' })], complete: true } }), /Context/);
  assert.equal(f.box.snapshot().total, 0);
  assert.throws(() => f.box.sync({ sessionId: binding.sessionId, approvals: { items: [approval(1, 'arbitrary-private-status')], complete: true } }), /Invalid approval/);
  assert.throws(() => f.box.sync({ sessionId: binding.sessionId, objectives: [objective(1, 'completed', { agent_id: 'foreign-agent' })] }), /Agent/);
  f.box.sync({ sessionId: binding.sessionId, events: [event()] });
  assert.throws(() => f.box.sync({ sessionId: binding.sessionId, events: [event('new'), event('event-1', { sequence: 2 })] }), /Immutable/);
  assert.equal(f.box.snapshot().total, 1);
  assert.throws(() => new NotificationOutbox(f.path, { ...binding, userId: 'other-user' }), /another user/);
});

test('approvals are revision-bound and resolved or complete-omitted notices cannot return from stale replay', t => {
  const f = fixture(t); const sync = (items: RuntimeApproval[], complete = true) => f.box.sync({ sessionId: binding.sessionId, approvals: { items, complete } });
  const first = sync([approval()]).items[0]; f.box.acknowledge([first.id]);
  const second = sync([approval(2)]).items[0]; assert.notEqual(second.id, first.id); assert.equal(second.read, false);
  assert.throws(() => f.box.acknowledge([first.id]), /no longer available/);
  assert.equal(sync([], false).items.length, 1); // a truncated inventory is not proof of resolution
  assert.equal(sync([approval(3, 'denied')]).items.length, 0);
  assert.equal(sync([approval(2)]).items.length, 0); // old pending projection cannot reopen a resolved request
  assert.equal(sync([approval(4)]).items.length, 1);
  assert.equal(sync([]).items.length, 0);
  assert.equal(sync([approval(4)]).items.length, 0); // omission fence survives exact replay
  f.restart(); assert.equal(sync([approval(4)]).items.length, 0);
});

test('only delivery-session terminal Objectives notify and housekeeping revisions do not remind again', t => {
  const f = fixture(t); const sync = (items: RuntimeObjective[]) => f.box.sync({ sessionId: binding.sessionId, objectives: items });
  assert.equal(sync([objective(1, 'active'), objective(1, 'completed', { id: 'sibling', delivery_session_id: 'sibling-session' })]).total, 0);
  const first = sync([objective(2)]).items[0]; f.box.acknowledge([first.id]);
  const same = sync([objective(3)]); assert.equal(same.total, 1); assert.equal(same.items[0].id, first.id); assert.equal(same.unread, 0);
  assert.equal(sync([objective(1, 'active')]).total, 1);
  assert.equal(sync([]).total, 1); // bounded objective inventories must not imply absence
  assert.equal(sync([objective(3, 'unknown')]).total, 1); // host uncertainty is not a new Runtime transition
  assert.equal(sync([objective(4, 'active')]).total, 0);
  assert.equal(sync([objective(5, 'failed')]).unread, 1);
  assert.throws(() => sync([objective(5, 'completed')]), /revision changed/);
});

test('off is durable and reenable or event replay never resurrects suppressed notifications', t => {
  const f = fixture(t); f.box.sync({ sessionId: binding.sessionId, events: [event()] });
  assert.equal(f.box.setMode('off').total, 0);
  f.box.sync({ sessionId: binding.sessionId, events: [event('during-off')] });
  f.restart(); assert.equal(f.box.snapshot().mode, 'off'); assert.equal(f.box.snapshot().unread, 0);
  f.box.setMode('all'); const state = f.box.sync({ sessionId: binding.sessionId, events: [event(), event('during-off'), event('after-on')] });
  assert.equal(state.total, 1); assert.equal(state.items[0].sourceId, 'after-on');
  assert.throws(() => f.box.setMode('external' as any), /all or off/);
});

test('acknowledgement is scoped and atomic; pagination reports hidden unread without inventing human delivery', t => {
  const f = fixture(t); f.box.sync({ sessionId: binding.sessionId, events: [event('one'), event('two'), event('three')] });
  const state = f.box.snapshot(2); assert.equal(state.items.length, 2); assert.equal(state.truncated, true); assert.equal(state.total, 3); assert.equal(state.unread, 3);
  assert.throws(() => f.box.acknowledge([state.items[0].id, '0'.repeat(64)]), /no longer available/);
  assert.equal(f.box.snapshot().unread, 3);
  f.box.acknowledge([state.items[0].id, state.items[0].id]); assert.equal(f.box.snapshot().unread, 2);
  assert.throws(() => f.box.acknowledge(['../../unknown']), /identities/);
  assert.throws(() => f.box.snapshot(201), /limit/);
  assert.ok(!JSON.stringify(f.box.snapshot()).includes('deliveredAt'));
});

test('opaque keyset pages reach every notice across restart and reject foreign or malformed cursors', t => {
  const f = fixture(t); f.box.sync({ sessionId: binding.sessionId, events: [event('one'), event('two'), event('three'), event('four'), event('five')] });
  const first = f.box.snapshot(2); assert.ok(first.nextCursor); const seen = first.items.map(item => item.id);
  f.restart(); const second = f.box.snapshot(2, first.nextCursor!); assert.ok(second.nextCursor); seen.push(...second.items.map(item => item.id));
  const third = f.box.snapshot(2, second.nextCursor!); seen.push(...third.items.map(item => item.id));
  assert.equal(third.nextCursor, null); assert.equal(third.truncated, false); assert.equal(new Set(seen).size, 5);
  f.box.acknowledge(seen); assert.equal(f.box.snapshot().unread, 0);
  for (const bad of ['', '../../outside', 'f'.repeat(600), Buffer.from(JSON.stringify([1, 'foreign-session', 1000, '0'.repeat(64)])).toString('base64url')]) assert.throws(() => f.box.snapshot(2, bad), /cursor/);
});
