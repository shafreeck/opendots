import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductStore, ConflictError, MissingError } from '../src/store.ts';
import type { IoEventPage } from '../src/morphz-adapter.ts';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-store-'));
  const path = join(directory, 'store.sqlite');
  const store = new ProductStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}

test('enqueue is idempotent and rejects changed intent under the same key', t => {
  const { store } = fixture(t);
  const first = store.enqueue('A demo delivery', 'stable-key', true, 1000);
  assert.equal(store.enqueue('A demo delivery', 'stable-key', true, 1100).id, first.id);
  assert.throws(() => store.enqueue('Changed', 'stable-key', true), ConflictError);
  assert.throws(() => store.enqueue('A demo delivery', 'stable-key', false), ConflictError);
  assert.equal(store.snapshot().jobs.length, 1);
  assert.equal(store.snapshot().audit.length, 1);
});

test('approval gate is enforced in claim, repeat decisions are safe, denial is terminal', t => {
  const { store } = fixture(t);
  const approved = store.enqueue('Wait for me', 'approve-key', true, 1000);
  const denied = store.enqueue('Do not send', 'deny-key', true, 1001);
  assert.equal(store.claim(1100), undefined);
  store.decide(approved.id, 'approve', 1200);
  store.decide(approved.id, 'approve', 1201);
  store.decide(denied.id, 'deny', 1202);
  store.decide(denied.id, 'deny', 1203);
  assert.throws(() => store.decide(denied.id, 'approve'), ConflictError);
  assert.throws(() => store.decide('missing', 'deny'), MissingError);
  const claim = store.claim(1300)!;
  assert.equal(claim.id, approved.id);
  assert.equal(claim.approval_status, 'approved');
  assert.equal(store.claim(1400), undefined);
  assert.equal(store.getJob(denied.id)?.status, 'cancelled');
  assert.equal(store.snapshot().audit.filter(row => String(row.event).startsWith('approval.')).length, 2);
});

test('expired durable leases recover across connections and fence stale workers', t => {
  const { store, path } = fixture(t);
  const job = store.enqueue('Resume after interruption', 'recover-key', false, 1000);
  const first = store.claim(1100, 100)!;
  assert.equal(first.attempts, 1);
  const secondConnection = new ProductStore(path);
  try {
    const recovered = secondConnection.claim(1201, 100)!;
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.lease_token, first.lease_token);
    assert.equal(store.complete(job.id, first.lease_token!, 1210), false);
    assert.equal(store.renew(job.id, first.lease_token!, 1210), false);
    assert.equal(secondConnection.complete(job.id, recovered.lease_token!, 1220), true);
    assert.equal(secondConnection.complete(job.id, recovered.lease_token!, 1221), false);
    assert.equal(store.snapshot().messages.length, 1);
    assert.match(String(store.snapshot().messages[0].text), /Simulated/);
    assert.ok(store.snapshot().audit.some(row => row.event === 'lease.recovered'));
  } finally { secondConnection.close(); }
});

test('expired lease cannot renew or complete before recovery', t => {
  const { store } = fixture(t);
  store.enqueue('Expired', 'expire-key', false, 1000);
  const job = store.claim(1000, 10)!;
  assert.equal(store.renew(job.id, job.lease_token!, 1010), false);
  assert.equal(store.complete(job.id, job.lease_token!, 1011), false);
  assert.equal(store.snapshot().messages.length, 0);
});

test('chat acknowledgement is durable and duplicate-safe', t => {
  const { store, path } = fixture(t);
  assert.equal(store.addDemoChat('hello', 'chat-key', 1000).duplicate, false);
  assert.equal(store.addDemoChat('hello', 'chat-key', 1001).duplicate, true);
  assert.throws(() => store.addDemoChat('different', 'chat-key'), ConflictError);
  const reopened = new ProductStore(path);
  try {
    assert.equal(reopened.snapshot().messages.length, 2);
    assert.match(String(reopened.snapshot().messages[1].text), /No AI response/);
  } finally { reopened.close(); }
});

const page = (cursor = 'opaque-page-one'): IoEventPage => ({
  subscription: { io_version: '1' }, cursor,
  events: [
    { io_version: '1', event_id: 'event-a', type: 'input.accepted', sequence: 12 },
    { io_version: '1', event_id: 'event-b', type: 'output.committed', sequence: 19 },
  ],
});

test('event inbox deduplicates pages and preserves opaque cursors across gaps', t => {
  const { store, path } = fixture(t);
  assert.equal(store.ingestEventPage('session-a', null, page()), 2);
  assert.equal(store.ingestEventPage('session-a', null, page()), 0);
  assert.equal(store.eventCursor('session-a'), 'opaque-page-one');
  assert.equal(store.eventCursor('session-b'), null);
  const empty = { subscription: {}, events: [], cursor: 'opaque-page-two' };
  assert.equal(store.ingestEventPage('session-a', 'opaque-page-one', empty), 0);
  assert.equal(store.eventCursor('session-a'), 'opaque-page-two');
  const reopened = new ProductStore(path);
  try { assert.equal(reopened.eventCursor('session-a'), 'opaque-page-two'); }
  finally { reopened.close(); }
});

test('conflicting or stale event pages roll back atomically', t => {
  const { store } = fixture(t);
  store.ingestEventPage('session-a', null, page());
  const conflicting = page('next');
  conflicting.events[1].type = 'tampered';
  assert.throws(() => store.ingestEventPage('session-a', 'opaque-page-one', conflicting), ConflictError);
  assert.equal(store.eventCursor('session-a'), 'opaque-page-one');
  assert.throws(() => store.ingestEventPage('session-a', 'stale-cursor', { subscription: {}, events: [], cursor: 'wrong-next' }), ConflictError);
  assert.equal(store.eventCursor('session-a'), 'opaque-page-one');
  const badPage = page('bad');
  badPage.events[1].sequence = 1;
  assert.throws(() => store.ingestEventPage('new-session', null, badPage), ConflictError);
  assert.equal(store.eventCursor('new-session'), null);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM event_inbox WHERE session_id=?').get('new-session')?.count, 0);
});


test('pending deliveries survive closing and reopening the SQLite store', t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-restart-'));
  const path = join(directory, 'store.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new ProductStore(path);
  const job = first.enqueue('Resume me', 'restart-key', false, 1000);
  const leased = first.claim(1000, 100)!;
  first.close();
  const reopened = new ProductStore(path);
  try {
    assert.equal(reopened.getJob(job.id)?.status, 'running');
    const recovered = reopened.claim(1101, 100)!;
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.lease_token, leased.lease_token);
    assert.equal(reopened.complete(job.id, recovered.lease_token!, 1110), true);
  } finally { reopened.close(); }
});
