import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStore } from '../src/runtime-store.ts';

test('linked product intent and durable command commit or roll back atomically', () => {
  const store = new RuntimeStore(':memory:');
  try {
    store.db.exec('CREATE TABLE linked_intent (id TEXT PRIMARY KEY, command_id TEXT)');
    assert.throws(() => store.prepare('chat', 'atomic-attempt', { text: 'hello' }, id => {
      assert.equal(store.db.isTransaction, true);
      store.db.prepare('INSERT INTO linked_intent VALUES(?,?)').run('draft', id);
      throw Error('seal failed');
    }), /seal failed/);
    assert.equal(store.commandByKey('atomic-attempt'), undefined);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM linked_intent').get()!.n, 0);
    let calls = 0;
    const first = store.prepare('chat', 'atomic-attempt', { text: 'hello' }, id => {
      calls++; store.db.prepare('INSERT INTO linked_intent VALUES(?,?)').run('draft', id);
    });
    assert.equal(store.db.prepare('SELECT command_id FROM linked_intent').get()!.command_id, first.id);
    assert.equal(store.prepare('chat', 'atomic-attempt', { text: 'hello' }, () => { calls++; }).id, first.id);
    assert.equal(calls, 1);
    assert.throws(() => store.prepare('chat', 'atomic-attempt', { text: 'changed' }, () => { calls++; }));
    assert.equal(calls, 1);
  } finally { store.close(); }
});
