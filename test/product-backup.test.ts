import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RuntimeStore } from '../src/runtime-store.ts';
import { OwnerAuth } from '../src/auth-sessions.ts';
import { authDigest, validateOwnerAuthConfig } from '../src/auth-config.ts';
import { CalendarReminders, type CalendarRule } from '../src/calendar-reminders.ts';
import { CalendarProposals } from '../src/calendar-proposals.ts';
import { ArtifactVersions } from '../src/artifact-versions.ts';
import { createProductSnapshot, verifyProductSnapshot, restoreProductSnapshot } from '../src/product-backup.ts';

const config = validateOwnerAuthConfig({ version: 1, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest('e'.repeat(64)) }, sessionTtlSeconds: 3600, idleTtlSeconds: 3600, maximumDevices: 8 });
const origin = 'https://backup-fixture.example';
function rootFor(t: test.TestContext) { const root = mkdtempSync(join(tmpdir(), 'opendots-backup-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
async function fixture(t: test.TestContext, authenticated = true) {
  const root = rootFor(t), source = join(root, 'source.sqlite');
  writeFileSync(source, '', { flag: 'wx', mode: 0o600 });
  const store = new RuntimeStore(source), binding = store.ensureBinding('http://127.0.0.1:39999');
  store.verifyBinding({ id: binding.sessionId, agent_id: binding.agentId, context_id: binding.contextId, status: 'active' }, 'principal-fixture');
  const event: any = { io_version: '1', type: 'output.committed', event_id: 'event-fixture', sequence: 1, session_id: binding.sessionId, message: { content: { encoding: 'utf8', text: 'PRIVATE-FIXTURE-CONVERSATION' } } };
  store.ingest(binding.sessionId, { subscription: {}, cursor: 'opaque-fixture-cursor', events: [event] });
  const submitted = store.prepare('chat', 'submitting-fixture', { text: 'PRIVATE-FIXTURE-INPUT', client_message_id: 'native-input-fixture' }); store.attempted(submitted.id);
  const uncertain = store.prepare('objective', 'unknown-fixture', { id: 'native-objective-fixture', prompt: 'Fixture objective' }); store.record(uncertain.id, 'unknown', { id: 'native-objective-fixture' }, 'receipt_lost');
  const accepted = store.prepare('chat', 'accepted-fixture', { text: 'accepted', client_message_id: 'accepted-native-fixture' }); store.record(accepted.id, 'accepted', { event_id: 'accepted-event' });
  let calls = 0;
  const calendar = new CalendarReminders({ db: store.db, binding: { ownerId: binding.userId, sessionId: binding.sessionId }, authorize: async () => {}, now: () => Date.parse('2030-01-01T08:00:00Z'), adapter: {
    getSchedule: async () => { calls++; throw Error('Fixture only'); }, controlSchedule: async () => { calls++; throw Error('Fixture only'); },
    createSchedule: async (_session, input) => { calls++; return { ...input, revision: 1, status: 'queued', interval_seconds: null, thread_id: 'native-schedule-thread-fixture', source_turn_id: 'native-schedule-turn-fixture' }; },
  } });
  const rule: CalendarRule = { intent: 'Private fixture reminder', timeZone: 'UTC', frequency: 'daily', localTime: '09:00', startDate: '2030-01-01', dst: { gap: 'skip', overlap: 'earlier' }, missed: 'skip_unsubmitted', resume: 'skip_overdue_paused' };
  const series = await calendar.create({ ...rule, idempotencyKey: 'calendar-fixture-create' });
  store.db.prepare("UPDATE calendar_occurrences SET state='unknown',error_code='calendar_create_unconfirmed' WHERE id=?").run(series.occurrence!.id);
  new CalendarProposals({ db: store.db, ownerId: binding.userId, sessionId: binding.sessionId });
  store.db.exec(`CREATE TABLE computer_edge_journal(scope TEXT NOT NULL,job_id TEXT NOT NULL,fingerprint TEXT NOT NULL,thread_id TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,finish_json TEXT,lease_json TEXT,delivered INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,job_id));
    CREATE TABLE computer_edge_observations(scope TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,epoch INTEGER NOT NULL,display_id TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT,PRIMARY KEY(scope,id));`);
  store.db.prepare('INSERT INTO computer_edge_journal VALUES(?,?,?,?,?,?,?,?,?,?)').run('fixed-scope', 'native-job-fixture', 'fingerprint', 'native-thread-fixture', 'unknown', 'Unconfirmed physical effect', null, null, 0, 1);
  const auth = authenticated ? new OwnerAuth({ db: store.db, ownerId: binding.userId, origin, config }) : undefined;
  const login = auth ? await auth.login({ credential: 'e'.repeat(64), deviceLabel: 'Synthetic old device' }, { origin, remoteAddress: '127.0.0.1' }) : undefined;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await auth?.close(); await calendar.close(); store.close(); } };
  t.after(close);
  return { root, source, store, auth, login, binding: store.binding()!, series, submitted, uncertain, accepted, calls: () => calls, close };
}
function privateRead(path: string) { return new DatabaseSync(path, { readOnly: true }); }
function contentHash(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function amendManifest(directory: string, change: (manifest: any) => void) {
  const path = join(directory, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8')); change(manifest); writeFileSync(path, JSON.stringify(manifest));
}

test('supported SQLite backup captures committed live WAL data and publishes private versioned integrity manifest', async t => {
  const f = await fixture(t), beforeCalls = f.calls(), before = f.store.snapshot();
  assert.ok(existsSync(f.source + '-wal'));
  const destination = join(f.root, 'snapshot'), snapshot = await createProductSnapshot({ source: f.source, destination });
  assert.deepEqual(readdirSync(destination).sort(), ['manifest.json', 'product.sqlite']);
  assert.equal(statSync(destination).mode & 0o777, 0o700);
  for (const path of [snapshot.databasePath, snapshot.manifestPath]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(snapshot.manifest.version, 1); assert.equal(snapshot.manifest.database.sha256, contentHash(snapshot.databasePath));
  assert.deepEqual(verifyProductSnapshot(destination), snapshot.manifest);
  assert.equal(f.calls(), beforeCalls); assert.deepEqual(f.store.snapshot(), before);
  const copy = privateRead(snapshot.databasePath);
  try {
    assert.equal(copy.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    assert.equal((copy.prepare('SELECT value_json FROM runtime_binding').get() as any).value_json, JSON.stringify(f.binding));
    assert.equal((copy.prepare('SELECT status FROM runtime_commands WHERE id=?').get(f.submitted.id) as any).status, 'submitting');
    assert.equal((copy.prepare('SELECT value_json FROM runtime_io_events').get() as any).value_json, (f.store.db.prepare('SELECT value_json FROM runtime_io_events').get() as any).value_json);
  } finally { copy.close(); }
  assert.ok(!JSON.stringify(snapshot.manifest).includes('PRIVATE-FIXTURE'));
  assert.ok(!JSON.stringify(snapshot.manifest).includes(f.binding.userId));
});

test('restore preserves exact identities/history/calendar/uncertainty but rejects all old device sessions', async t => {
  const f = await fixture(t), snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, 'snapshot') });
  const cookie = f.login!.setCookie.split(';')[0], authBefore = f.store.db.prepare('SELECT * FROM auth_owner_state').get()!;
  const savedRows = new Map(['runtime_binding','runtime_commands','runtime_io_events','runtime_io_cursors','runtime_views','runtime_audit','calendar_series','calendar_occurrences','calendar_commands','calendar_reconcile_cursor','calendar_proposals','calendar_proposal_tool_receipts','computer_edge_journal','computer_edge_observations'].map(table => [table, f.store.db.prepare(`SELECT * FROM ${table}`).all()]));
  f.store.prepare('chat', 'created-after-snapshot', { text: 'This later intent cannot be recovered from an older image' });
  f.auth!.revokeAll(cookie, f.login!.session.csrfToken, origin); await f.close();
  const restored = await restoreProductSnapshot({ snapshot: snapshot.directory, destination: join(f.root, 'restored'), appStopped: true });
  assert.equal(restored.invalidatedSessions, 1); assert.equal(restored.ownerAuthentication, true);
  assert.deepEqual(verifyProductSnapshot(snapshot.directory), snapshot.manifest); // immutable original snapshot
  const db = new DatabaseSync(restored.databasePath);
  try {
    for (const [table, rows] of savedRows) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
    const after = db.prepare('SELECT * FROM auth_owner_state').get()!;
    assert.deepEqual({ ...after }, { ...authBefore, generation: Number(authBefore.generation) + 1 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_device_sessions').get()?.n, 0);
    const auth = new OwnerAuth({ db, ownerId: f.binding.userId, origin, config });
    assert.equal(auth.authenticate(cookie), null); await auth.close();
  } finally { db.close(); }
  const boot = new RuntimeStore(restored.databasePath);
  try {
    assert.deepEqual(boot.binding(), f.binding);
    assert.equal(boot.command(f.submitted.id)!.status, 'unknown'); assert.equal(boot.command(f.submitted.id)!.errorCode, 'host_restarted');
    assert.equal(boot.command(f.uncertain.id)!.status, 'unknown'); assert.deepEqual(boot.command(f.uncertain.id)!.receipt, { id: 'native-objective-fixture' });
    assert.equal(boot.command(f.accepted.id)!.status, 'accepted'); assert.equal(boot.cursor(f.binding.sessionId), 'opaque-fixture-cursor');
    assert.equal(boot.commandByKey('created-after-snapshot'), undefined);
  } finally { boot.close(); }
  const receipt = JSON.parse(readFileSync(restored.receiptPath, 'utf8'));
  assert.equal(receipt.reconnectPerformed, false); assert.equal(receipt.restoredSha256.length, 64);
});

test('restore requires stopped-app acknowledgment and never replaces source, snapshot or any existing destination', async t => {
  const f = await fixture(t), snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, 'snapshot') });
  await assert.rejects(restoreProductSnapshot({ snapshot: snapshot.directory, destination: join(f.root, 'absent'), appStopped: false }), { code: 'backup_app_stopped_acknowledgment_required' });
  assert.equal(existsSync(join(f.root, 'absent')), false);
  const before = contentHash(snapshot.databasePath), existing = join(f.root, 'existing'); mkdirSync(existing, { mode: 0o700 }); writeFileSync(join(existing, 'keep.txt'), 'KEEP', { mode: 0o600 });
  for (const destination of [f.source, snapshot.directory, snapshot.databasePath, existing]) {
    await assert.rejects(restoreProductSnapshot({ snapshot: snapshot.directory, destination, appStopped: true }));
    await assert.rejects(createProductSnapshot({ source: f.source, destination }));
  }
  assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'KEEP'); assert.equal(contentHash(snapshot.databasePath), before);
});

test('an interrupted destination-directory rename fails without publishing a successful snapshot', async t => {
  const f = await fixture(t), destination = join(f.root, 'snapshot'), moved = join(f.root, 'moved-incomplete');
  const operation = createProductSnapshot({ source: f.source, destination });
  assert.equal(existsSync(destination), true); renameSync(destination, moved);
  await assert.rejects(operation, { code: 'backup_directory_changed' });
  assert.equal(existsSync(destination), false); assert.equal(existsSync(join(moved, 'manifest.json')), false);
  assert.equal(statSync(moved).mode & 0o777, 0o700);
  for (const name of readdirSync(moved)) assert.equal(statSync(join(moved, name)).mode & 0o077, 0);
});

test('corruption, manifest hash/length mismatch and unsupported manifest/schema versions fail before output creation', async t => {
  const f = await fixture(t);
  for (const variant of ['hash','size','version','corrupt','schema-version']) {
    const snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, variant) });
    if (variant === 'hash') amendManifest(snapshot.directory, m => { m.database.sha256 = '0'.repeat(64); });
    if (variant === 'size') amendManifest(snapshot.directory, m => { m.database.bytes++; });
    if (variant === 'version') amendManifest(snapshot.directory, m => { m.version = 2; });
    if (variant === 'corrupt') { writeFileSync(snapshot.databasePath, Buffer.alloc(4096)); amendManifest(snapshot.directory, m => { m.database.bytes = 4096; m.database.sha256 = contentHash(snapshot.databasePath); }); }
    if (variant === 'schema-version') { const db = new DatabaseSync(snapshot.databasePath); db.exec('PRAGMA user_version=99'); db.close(); amendManifest(snapshot.directory, m => { m.database.sha256 = contentHash(snapshot.databasePath); }); }
    assert.throws(() => verifyProductSnapshot(snapshot.directory));
    const destination = join(f.root, variant + '-restore');
    await assert.rejects(restoreProductSnapshot({ snapshot: snapshot.directory, destination, appStopped: true })); assert.equal(existsSync(destination), false);
  }
});

test('symlinks, hard links, permissive files and untrusted writable parents are refused', async t => {
  const f = await fixture(t), snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, 'snapshot') });
  const alias = join(f.root, 'alias.sqlite'); symlinkSync(f.source, alias);
  await assert.rejects(createProductSnapshot({ source: alias, destination: join(f.root, 'no-symlink') }));
  const linked = join(f.root, 'hard.sqlite'); linkSync(f.source, linked);
  await assert.rejects(createProductSnapshot({ source: linked, destination: join(f.root, 'no-hardlink') })); rmSync(linked);
  const dirAlias = join(f.root, 'snapshot-alias'); symlinkSync(snapshot.directory, dirAlias);
  assert.throws(() => verifyProductSnapshot(dirAlias));
  const destinationAlias = join(f.root, 'destination-alias'); symlinkSync(join(f.root, 'absent'), destinationAlias);
  await assert.rejects(restoreProductSnapshot({ snapshot: snapshot.directory, destination: destinationAlias, appStopped: true }));
  const unsafeParent = join(f.root, 'writable'); mkdirSync(unsafeParent, { mode: 0o700 }); chmodSync(unsafeParent, 0o777);
  await assert.rejects(createProductSnapshot({ source: f.source, destination: join(unsafeParent, 'nope') }), { code: 'backup_parent_untrusted' });
  chmodSync(f.source, 0o644); await assert.rejects(createProductSnapshot({ source: f.source, destination: join(f.root, 'no-public-source') }), { code: 'backup_file_unsafe' }); chmodSync(f.source, 0o600);
  const manifest = join(snapshot.directory, 'manifest.json'), original = readFileSync(manifest); rmSync(manifest); symlinkSync(f.source, manifest);
  assert.throws(() => verifyProductSnapshot(snapshot.directory)); rmSync(manifest); writeFileSync(manifest, original, { mode: 0o600 });
  writeFileSync(snapshot.databasePath + '-wal', 'unhashed sidecar', { mode: 0o600 }); assert.throws(() => verifyProductSnapshot(snapshot.directory), { code: 'backup_snapshot_files_invalid' });
});

test('malformed/incomplete or foreign product schema cannot be restored as a valid product DB', async t => {
  const root = rootFor(t);
  for (const sql of ['CREATE TABLE foreign_runtime(id TEXT)', 'CREATE TABLE runtime_binding(singleton INTEGER,value_json TEXT)', 'CREATE TABLE anything(id TEXT)']) {
    const source = join(root, 'source-' + createHash('sha256').update(sql).digest('hex') + '.sqlite'); writeFileSync(source, '', { mode: 0o600 }); const db = new DatabaseSync(source); db.exec(sql); db.close();
    await assert.rejects(createProductSnapshot({ source, destination: source + '-snapshot' })); assert.equal(existsSync(source + '-snapshot'), false);
  }
  const f = await fixture(t);
  f.store.db.exec('CREATE TRIGGER unsafe_restore AFTER DELETE ON auth_device_sessions BEGIN DELETE FROM runtime_commands; END');
  await assert.rejects(createProductSnapshot({ source: f.source, destination: join(f.root, 'trigger') }), { code: 'backup_product_schema_unsupported' });
  f.store.db.exec('DROP TRIGGER unsafe_restore; DROP TABLE auth_attempt_windows;');
  await assert.rejects(createProductSnapshot({ source: f.source, destination: join(f.root, 'partial-auth') }), { code: 'backup_auth_schema_invalid' });
});

test('separate computer-control database and arbitrary config files are neither read nor included', async t => {
  const f = await fixture(t);
  writeFileSync(f.source + '.computer', 'not SQLite: deliberately must not be opened', { mode: 0o600 });
  writeFileSync(join(f.root, 'operator-config.json'), 'SYNTHETIC-CONFIG-SECRET', { mode: 0o600 });
  const snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, 'snapshot') });
  assert.deepEqual(readdirSync(snapshot.directory).sort(), ['manifest.json','product.sqlite']);
  assert.equal(readFileSync(f.source + '.computer', 'utf8'), 'not SQLite: deliberately must not be opened');
  assert.ok(!readFileSync(snapshot.databasePath).includes(Buffer.from('SYNTHETIC-CONFIG-SECRET')));
  await f.close();
  symlinkSync(join(f.root, 'operator-config.json'), f.source + '-wal');
  await assert.rejects(createProductSnapshot({ source: f.source, destination: join(f.root, 'sidecar-refused') }), { code: 'backup_file_unsafe' });
});

test('unauthenticated snapshots preserve that historical mode without inventing an identity or config', async t => {
  const f = await fixture(t, false), snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, 'snapshot') }); await f.close();
  const result = await restoreProductSnapshot({ snapshot: snapshot.directory, destination: join(f.root, 'restored'), appStopped: true });
  assert.equal(result.ownerAuthentication, false); assert.equal(result.invalidatedSessions, 0);
  const db = privateRead(result.databasePath);
  try { assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='auth_owner_state'").get(), undefined); assert.equal(db.prepare('SELECT value_json FROM runtime_binding').get()?.value_json, JSON.stringify(f.binding)); }
  finally { db.close(); }
});

test('artifact document lineage and immutable native-reference receipts survive backup and restore exactly', async t => {
  const f = await fixture(t); let resolverCalls = 0;
  const resource = (id: string) => ({ sessionId: f.binding.sessionId, artifact: { id, name: 'fixture.txt', mediaType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64), sourceEventId: 'artifact-event-' + id.slice(0, 1), origin: 'output' as const, createdAt: null, downloadable: true, downloadPath: `/api/artifacts/${id}/content` } });
  const versions = new ArtifactVersions({ db: f.store.db, binding: { ownerId: f.binding.userId, sessionId: f.binding.sessionId, verified: true }, assertAuthorized: () => {}, resolveArtifact: async id => { resolverCalls++; return resource(id); }, downloadArtifact: async id => ({ ...resource(id), bytes: new Uint8Array([1, 2, 3]) }) });
  const initial = await versions.create({ title: 'Fixture versions', artifactId: 'a'.repeat(64), idempotencyKey: 'version-create-fixture' });
  await versions.append(initial.documentAtAdmission.id, { artifactId: 'b'.repeat(64), expectedRevision: 1, parentVersionId: initial.version.id, idempotencyKey: 'version-append-fixture' });
  const tables = ['artifact_documents','artifact_document_versions','artifact_version_commands'];
  const before = tables.map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all());
  await versions.close(); const snapshot = await createProductSnapshot({ source: f.source, destination: join(f.root, 'snapshot') }); await f.close();
  const restored = await restoreProductSnapshot({ snapshot: snapshot.directory, destination: join(f.root, 'restored'), appStopped: true });
  const db = privateRead(restored.databasePath);
  try { tables.forEach((table, index) => assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[index], table)); } finally { db.close(); }
  assert.equal(resolverCalls, 2);
});

test('CLI performs explicit snapshot/verify/restore with concise output and rejects ambiguous arguments', async t => {
  const f = await fixture(t); await f.close();
  const cli = new URL('../scripts/product-backup.mjs', import.meta.url).pathname;
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
  const destination = join(f.root, 'cli-snapshot'), restored = join(f.root, 'cli-restored');
  const made = run('snapshot', '--source', f.source, '--destination', destination); assert.equal(made.status, 0, made.stderr); assert.equal(JSON.parse(made.stdout).status, 'snapshot_created');
  const verified = run('verify', '--snapshot', destination); assert.equal(verified.status, 0, verified.stderr); assert.deepEqual(JSON.parse(verified.stdout), { status: 'snapshot_verified' });
  assert.equal(run('restore', '--snapshot', destination, '--destination', restored).status, 1); assert.equal(existsSync(restored), false);
  const result = run('restore', '--snapshot', destination, '--destination', restored, '--app-stopped'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reconnectPerformed, false);
  for (const args of [[], ['snapshot','--source',f.source,'--source',f.source,'--destination',join(f.root,'bad')], ['verify','--snapshot',destination,'--unknown'], ['--help','extra']]) assert.equal(run(...args).status, 1);
  for (const output of [made.stdout, made.stderr, result.stdout, result.stderr]) { assert.ok(!output.includes('PRIVATE-FIXTURE')); assert.ok(!output.includes('e'.repeat(64))); }
});
