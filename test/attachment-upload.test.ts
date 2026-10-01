import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentUploads, AttachmentUploadError, attachmentUploadLimits, type AttachmentStageAdapter, type NativeAttachmentStage, type AttachmentUploadInput } from '../src/attachment-upload.ts';
import { LocalOperatorAdapter, MorphzError } from '../src/morphz-adapter.ts';
import { RuntimeStore } from '../src/runtime-store.ts';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('synthetic file bytes');
const binding = { userId: 'user-1', principalId: 'principal-1', sessionId: 'session-1' };
const declaration = (extra: Partial<AttachmentUploadInput> = {}): AttachmentUploadInput => ({ draftKey: 'draft-key-001', uploadKey: 'upload-key-001', name: 'notes.txt', mediaType: 'text/plain', sizeBytes: bytes.length, sha256: sha(bytes), ...extra });
const httpError = (status: number) => Object.assign(new Error('SYNTHETIC_PRIVATE_NATIVE_ERROR'), { status });
function native() {
  const records = new Map<string, NativeAttachmentStage>(); const content = new Map<string, Buffer>(); const calls = { creates: 0, uploads: 0, cancels: 0, gets: 0 }; let loseCreate = false; let loseUpload = false; let partial = 0; let loseCancel = false;
  const adapter: AttachmentStageAdapter = {
    createAttachmentStage: async (session, value) => {
      calls.creates++; const found = records.get(value.stage_id); if (found) return structuredClone(found);
      const record: NativeAttachmentStage = { ...value, principal_id: binding.principalId, session_id: session, offset: 0, sha256: null, status: 'uploading', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), consumed_event_id: null };
      records.set(value.stage_id, record); content.set(value.stage_id, Buffer.alloc(0)); if (loseCreate) { loseCreate = false; throw httpError(503); } return structuredClone(record);
    },
    getAttachmentStage: async (_session, id) => { calls.gets++; const record = records.get(id); if (!record) throw httpError(404); return structuredClone(record); },
    uploadAttachmentStage: async (_session, id, offset, chunk) => {
      calls.uploads++; const record = records.get(id); if (!record) throw httpError(404); if (record.offset !== offset) throw httpError(409);
      const accepted = partial ? chunk.subarray(0, partial) : chunk; content.set(id, Buffer.concat([content.get(id)!, accepted])); record.offset += accepted.byteLength;
      if (partial) { partial = 0; throw httpError(503); }
      if (record.offset === record.size_bytes) { const checksum = sha(content.get(id)!); if (checksum !== record.expected_sha256) { record.offset = 0; content.set(id, Buffer.alloc(0)); throw httpError(409); } record.sha256 = checksum; record.status = 'ready'; }
      if (loseUpload) { loseUpload = false; throw httpError(503); } return structuredClone(record);
    },
    cancelAttachmentStage: async (_session, id) => { calls.cancels++; const record = records.get(id); if (!record) throw httpError(404); if (record.status === 'consumed') throw httpError(409); records.delete(id); content.delete(id); if (loseCancel) { loseCancel = false; throw httpError(503); } },
  };
  return { adapter, records, content, calls, loseCreate: () => { loseCreate = true; }, loseUpload: () => { loseUpload = true; }, partial: (count: number) => { partial = count; }, loseCancel: () => { loseCancel = true; } };
}
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-upload-')); const path = join(dir, 'app.db'); const backend = native(); let upload = new AttachmentUploads(path, backend.adapter, binding);
  t.after(() => { upload.close(); rmSync(dir, { recursive: true, force: true }); });
  return { backend, path, get upload() { return upload; }, restart: () => { upload.close(); upload = new AttachmentUploads(path, backend.adapter, binding); return upload; } };
}

test('stage declaration and fixed draft identity survive lost receipt, retries and product restart', async t => {
  const f = fixture(t); f.backend.loseCreate(); await assert.rejects(f.upload.create(declaration()), /same upload key/);
  const saved = f.upload.list()[0]; assert.equal(saved.status, 'unknown');
  const recovered = await f.restart().create(declaration()); assert.equal(recovered.id, saved.id); assert.equal(f.backend.calls.creates, 1);
  assert.ok(!JSON.stringify(recovered).includes('stage-')); assert.ok(!JSON.stringify(recovered).includes('principal-1'));
  await assert.rejects(f.upload.create(declaration({ name: 'different.txt' })), (e: any) => e.status === 409);
  await f.upload.upload(recovered.id, 0, bytes); const first = await f.upload.prepareSend(declaration().draftKey, [recovered.id]);
  const second = await f.restart().prepareSend(declaration().draftKey, [recovered.id]); assert.deepEqual(first, second);
  const nativeRecord = [...f.backend.records.values()][0]; assert.equal(nativeRecord.client_message_id, first.clientMessageId); assert.equal(nativeRecord.stage_id, first.attachments[0].stage_id);
  assert.ok(!readFileSync(f.path).includes(bytes), 'No second file-byte copy is stored in product database');
});

test('interrupted chunk resumes from native byte offset and never allocates a new stage or resends automatically', async t => {
  const f = fixture(t); const file = await f.upload.create(declaration()); f.backend.partial(5);
  await assert.rejects(f.upload.upload(file.id, 0, bytes), (e: any) => e.code === 'upload_unconfirmed');
  assert.equal(f.backend.calls.uploads, 1); assert.equal(f.upload.list()[0].offset, 5);
  await assert.rejects(f.restart().upload(file.id, 0, bytes), (e: any) => e.code === 'offset_conflict'); assert.equal(f.backend.calls.uploads, 1);
  const ready = await f.upload.upload(file.id, 5, bytes.subarray(5)); assert.equal(ready.status, 'ready'); assert.equal(ready.offset, bytes.length); assert.equal(f.backend.calls.creates, 1); assert.equal(f.backend.calls.uploads, 2);
  assert.deepEqual([...f.backend.content.values()][0], bytes);
});

test('lost final receipt reconciles verified ready digest, while a digest mismatch is never ready', async t => {
  const f = fixture(t); const file = await f.upload.create(declaration()); f.backend.loseUpload();
  assert.equal((await f.upload.upload(file.id, 0, bytes)).status, 'ready'); assert.equal(f.backend.calls.uploads, 1);
  const bad = await f.upload.create(declaration({ uploadKey: 'upload-key-002', name: 'bad.txt' }));
  await assert.rejects(f.upload.upload(bad.id, 0, Buffer.alloc(bytes.length)), (e: any) => e.status === 409); assert.equal(f.upload.list()[1].status, 'uploading'); assert.equal(f.upload.list()[1].offset, 0);
  await assert.rejects(f.upload.prepareSend(declaration().draftKey, [bad.id]), /ready stage/);
});

test('foreign native identity, declaration, digest and foreign draft selection fail closed', async t => {
  const f = fixture(t); const file = await f.upload.create(declaration()); const record = [...f.backend.records.values()][0];
  record.principal_id = 'foreign'; await assert.rejects(f.upload.reconcile(file.id)); record.principal_id = binding.principalId;
  record.client_message_id = 'foreign-draft'; await assert.rejects(f.upload.prepareSend(declaration().draftKey, [file.id]));
  await assert.rejects(f.upload.cancel('stage-guessed'), (e: any) => e.status === 404);
  const another = await f.upload.create(declaration({ draftKey: 'draft-key-002', uploadKey: 'upload-key-002' }));
  await assert.rejects(f.upload.prepareSend(declaration().draftKey, [another.id]), (e: any) => e.status === 403);
  assert.throws(() => new AttachmentUploads(f.path, f.backend.adapter, { ...binding, principalId: 'foreign' }), /another user/);
});

test('stage expiry never causes replacement and draft cancellation cannot erase Event-owned resources', async t => {
  const f = fixture(t); const file = await f.upload.create(declaration()); const id = [...f.backend.records.keys()][0]; f.backend.records.delete(id);
  assert.equal((await f.upload.reconcile(file.id)).status, 'missing'); await assert.rejects(f.upload.create(declaration()), (e: any) => e.status === 410); assert.equal(f.backend.calls.creates, 1);
  assert.equal((await f.upload.cancel(file.id)).status, 'cancelled');
  const next = await f.upload.create(declaration({ uploadKey: 'upload-key-002' })); await f.upload.upload(next.id, 0, bytes);
  const record = [...f.backend.records.values()][0]; record.status = 'consumed'; record.consumed_event_id = 'committed-input-event';
  assert.equal((await f.upload.reconcile(next.id)).status, 'consumed'); await assert.rejects(f.upload.cancel(next.id), (e: any) => e.code === 'stage_consumed'); assert.equal(f.backend.calls.cancels, 0);
  f.backend.records.delete(record.stage_id); const preserved = await f.upload.reconcile(next.id); assert.equal(preserved.status, 'consumed'); assert.equal(preserved.consumedEventId, 'committed-input-event');
});

test('lost cancel response reconciles missing stage under the same owned identity', async t => {
  const f = fixture(t); const file = await f.upload.create(declaration()); f.backend.loseCancel();
  assert.equal((await f.upload.cancel(file.id)).status, 'cancelled'); assert.equal(f.backend.calls.cancels, 1);
  assert.equal((await f.restart().cancel(file.id)).status, 'cancelled'); assert.equal(f.backend.calls.cancels, 1);
});

test('limits and filename/media declarations reject unsupported requests before native side effects', async t => {
  const f = fixture(t);
  for (const change of [{ name: '../secret.txt' }, { name: 'C:\\secret.txt' }, { mediaType: 'text/html' }, { sizeBytes: 0 }, { sizeBytes: attachmentUploadLimits.maximumBytes + 1 }, { sha256: 'bad' }, { sourceUrl: 'https://example.test' }]) await assert.rejects(f.upload.create(declaration(change as any)), AttachmentUploadError);
  assert.equal(f.backend.calls.creates, 0);
  const file = await f.upload.create(declaration()); await assert.rejects(f.upload.upload(file.id, 0, Buffer.alloc(attachmentUploadLimits.maximumChunkBytes + 1)), /bounded byte chunk/); assert.equal(f.backend.calls.uploads, 0);
});

test('seal shares command transaction, rolls back atomically and binds one exact command key/content', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-upload-seal-')); const store = new RuntimeStore(join(dir, 'app.db')); const b = native(); const uploads = new AttachmentUploads(store.db, b.adapter, binding);
  t.after(() => { uploads.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const file = await uploads.create(declaration()); await uploads.upload(file.id, 0, bytes);
  const refs = await uploads.prepareSend(declaration().draftKey, [file.id]); const payload = { text: 'Read attached file', ...refs }; const fingerprint = sha(JSON.stringify(payload));
  assert.throws(() => uploads.seal(declaration().draftKey, [file.id], 'chat-key-001', fingerprint), /share the same SQLite transaction/);
  assert.throws(() => store.prepare('chat', 'chat-key-001', payload, () => { uploads.seal(declaration().draftKey, [file.id], 'chat-key-001', fingerprint); throw Error('synthetic crash'); }), /synthetic crash/);
  assert.equal(uploads.list()[0].sealed, false); assert.equal(store.commands().length, 0);
  const first = store.prepare('chat', 'chat-key-001', payload, () => uploads.seal(declaration().draftKey, [file.id], 'chat-key-001', fingerprint));
  assert.equal(uploads.list()[0].sealed, true); assert.equal(store.prepare('chat', 'chat-key-001', payload).id, first.id);
  assert.throws(() => store.prepare('chat', 'chat-key-002', payload, () => uploads.seal(declaration().draftKey, [file.id], 'chat-key-002', fingerprint)), /different command/);
  assert.throws(() => store.prepare('chat', 'chat-key-001', { ...payload, text: 'changed' }), /another request/); assert.equal(store.commands().length, 1);
  await assert.rejects(uploads.cancel(file.id), /message-bound/); await assert.rejects(uploads.create(declaration({ uploadKey: 'upload-key-002' })), /already bound/);
  b.records.clear(); assert.deepEqual(await uploads.prepareSend(declaration().draftKey, [file.id]), refs, 'Exact command retry retains frozen refs even after native stage expiry');
});

test('native stage adapter encodes scope, sends bounded raw bytes and no error bodies or query tokens', async () => {
  const calls: any[] = [];
  const adapter = new LocalOperatorAdapter({ baseUrl: 'http://127.0.0.1:3001', operatorToken: 'synthetic-token', fetch: (async (url, init) => { calls.push({ url: String(url), init }); return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ fixture: true }); }) as typeof fetch });
  await adapter.createAttachmentStage('session/1', { stage_id: 'stage-1', client_message_id: 'client-1', name: 'note.txt', media_type: 'text/plain', size_bytes: 3, expected_sha256: sha('abc') });
  await adapter.getAttachmentStage('session/1', 'stage/1'); await adapter.uploadAttachmentStage('session/1', 'stage/1', 2, Buffer.from('c')); await adapter.cancelAttachmentStage('session/1', 'stage/1');
  assert.match(calls[1].url, /session%2F1\/attachment-stages\/stage%2F1$/); assert.ok(calls.every(call => !call.url.includes('?') && new Headers(call.init.headers).get('authorization') === 'Bearer synthetic-token' && call.init.redirect === 'error'));
  assert.equal(new Headers(calls[2].init.headers).get('x-morphz-upload-offset'), '2'); assert.deepEqual(calls[2].init.body, Buffer.from('c'));
  const denied = new LocalOperatorAdapter({ baseUrl: 'http://127.0.0.1:3001', fetch: (async () => new Response('SYNTHETIC_PRIVATE_ERROR', { status: 403 })) as typeof fetch });
  await assert.rejects(denied.uploadAttachmentStage('s', 'a', 0, bytes), e => e instanceof MorphzError && e.status === 403 && !e.message.includes('PRIVATE'));
});

for (const vanished of [false, true]) test(`a message seal during cancellation read prevents DELETE or cancelled acknowledgement (native missing: ${vanished})`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-upload-cancel-race-')); const store = new RuntimeStore(join(dir, 'app.db')); const b = native(); const uploads = new AttachmentUploads(store.db, b.adapter, binding);
  t.after(() => { uploads.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const file = await uploads.create(declaration()); await uploads.upload(file.id, 0, bytes); const envelope = await uploads.prepareSend(declaration().draftKey, [file.id]);
  const get = b.adapter.getAttachmentStage; let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
  b.adapter.getAttachmentStage = async (...args) => { entered(); await barrier; if (vanished) throw httpError(404); return get(...args); };
  const cancelled = uploads.cancel(file.id); await waiting;
  const payload = { text: 'Exact selected input', ...envelope }; store.prepare('chat', 'chat-key-race', payload, () => uploads.seal(declaration().draftKey, [file.id], 'chat-key-race', sha(JSON.stringify(payload))));
  release(); await assert.rejects(cancelled, (e: any) => e.code === 'draft_sealed'); assert.equal(b.calls.cancels, 0); assert.equal(uploads.list()[0].sealed, true); assert.equal(uploads.list()[0].status, vanished ? 'missing' : 'ready');
});

test('uncertain cancellation survives failed reads and ready projections without becoming sendable again', async t => {
  const f = fixture(t); const file = await f.upload.create(declaration()); await f.upload.upload(file.id, 0, bytes);
  f.backend.adapter.cancelAttachmentStage = async () => { throw httpError(503); };
  await assert.rejects(f.upload.cancel(file.id), (e: any) => e.code === 'cancel_unconfirmed'); assert.equal(f.upload.list()[0].status, 'cancelling');
  const get = f.backend.adapter.getAttachmentStage; f.backend.adapter.getAttachmentStage = async () => { throw httpError(503); };
  await assert.rejects(f.upload.reconcile(file.id)); assert.equal(f.upload.list()[0].status, 'cancelling');
  f.backend.adapter.getAttachmentStage = get; const result = await f.restart().reconcile(file.id); assert.equal(result.status, 'cancelling'); assert.equal(result.errorCode, 'cancel_unconfirmed');
  await assert.rejects(f.upload.prepareSend(declaration().draftKey, [file.id]), (e: any) => e.code === 'stage_not_ready');
  await assert.rejects(f.upload.upload(file.id, 0, bytes), (e: any) => e.code === 'upload_cancelled');
});
