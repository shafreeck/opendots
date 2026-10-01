import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export class ProductBackupError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ProductBackupError'; this.code = code; }
}
const check = (condition: unknown, code: string): void => { if (!condition) throw new ProductBackupError(code); };
const DATABASE = 'product.sqlite', MANIFEST = 'manifest.json', STAGING = 'incomplete.sqlite';
const MAX_DATABASE = 512 * 1024 * 1024, MAX_MANIFEST = 16_384;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
// Version 1 accepts only this product schema family, not arbitrary/Morphz SQLite
// databases. New tables/columns require explicit review and a tool update.
const columns: Record<string, string> = {
  runtime_binding: 'singleton,value_json',
  runtime_commands: 'id,command_key,kind,payload_json,payload_hash,status,receipt_json,error_code,attempts,created_at,updated_at',
  runtime_io_events: 'session_id,event_id,sequence,value_json',
  runtime_io_cursors: 'session_id,cursor', runtime_views: 'kind,id,value_json', runtime_audit: 'id,event,command_id,created_at',
  auth_owner_state: 'singleton,owner_id,origin,config_hash,generation',
  auth_device_sessions: 'id,token_hash,config_hash,generation,device_label,created_at,last_seen_at,expires_at',
  auth_attempt_windows: 'bucket,started_at,count',
  notification_binding: 'singleton,binding_json,mode', notification_heads: 'kind,source_id,revision,signature,notification_id',
  notification_outbox: 'id,kind,source_id,source_revision,source_status,source_at,created_at,read_at,state',
  opendots_reminders: 'id,session_id,command_key,fingerprint,input_json,state,receipt_json,error',
  calendar_series: 'id,owner_id,session_id,command_key,fingerprint,rule_json,desired,revision,current_id,cursor_date,error_code,control_requested,ended,created_at,updated_at',
  calendar_occurrences: 'id,series_id,local_date,time_json,attempted,state,receipt_json,control_json,error_code,hold_reason,advance_cancelled,resume_revision',
  calendar_commands: 'id,series_id,command_key,fingerprint,result_revision,action', calendar_reconcile_cursor: 'owner_id,session_id,cursor',
  calendar_proposals: 'id,owner_id,session_id,job_id,call_id,thread_id,rule_json,rule_hash,preview_json,state,revision,decision_from_revision,series_key,series_id,created_at,decision_at',
  calendar_proposal_tool_receipts: 'id,owner_id,session_id,arguments_hash,result_json,created_at',
  attachment_upload_binding: 'singleton,binding_json', attachment_drafts: 'draft_key,client_message_id,sealed_command_key,sealed_fingerprint,sealed_ids_json',
  attachment_uploads: 'id,upload_key,draft_key,stage_id,fingerprint,declaration_json,status,receipt_json,error_code,created_at,updated_at',
  connector_receipts: 'id,payload_hash,state,result_json,created_at,updated_at',
  computer_edge_journal: 'scope,job_id,fingerprint,thread_id,state,summary,finish_json,lease_json,delivered,expires_at',
  computer_edge_observations: 'scope,id,thread_id,epoch,display_id,width,height,expires_at,used_by',
  computer_approval_binding: 'singleton,value', computer_action_approvals: 'id,job_id,thread_id,epoch,observation_id,action_hash,image_hash,display_id,status,revision,expires_at,created_at,summary_json',
  artifact_documents: 'id,owner_id,session_id,title,revision,current_version_id,created_at,updated_at',
  artifact_document_versions: 'id,document_id,revision,parent_version_id,artifact_json,note,created_at',
  artifact_version_commands: 'id,owner_id,session_id,request_key,payload_fingerprint,receipt_json,created_at',
  sqlite_sequence: 'name,seq',
};
const requiredTables = ['runtime_binding', 'runtime_commands', 'runtime_io_events', 'runtime_io_cursors', 'runtime_views', 'runtime_audit'];
const authTables = ['auth_owner_state', 'auth_device_sessions', 'auth_attempt_windows'];
interface SchemaSummary { schemaSha256: string; identitySha256: string; ownerAuthentication: boolean }
export interface ProductSnapshotManifest extends SchemaSummary {
  format: 'opendots-product-snapshot'; version: 1; createdAt: string;
  database: { file: 'product.sqlite'; bytes: number; sha256: string };
}
export interface SnapshotResult { directory: string; databasePath: string; manifestPath: string; manifest: ProductSnapshotManifest }
export interface RestoreResult { directory: string; databasePath: string; receiptPath: string; invalidatedSessions: number; ownerAuthentication: boolean }
interface PinnedFile { path: string; fd: number; stat: Stats }
interface PinnedDirectory { path: string; fd: number; stat: Stats; anchor: string }

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function selectedPath(value: unknown): string {
  check(process.platform === 'linux' && typeof process.geteuid === 'function', 'backup_platform_unsupported');
  check(typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && normalize(value) === value && value !== '/' && !value.endsWith('/') && !/[\x00-\x1f\x7f]/.test(value), 'backup_path_invalid');
  return value as string;
}
function trustedParents(path: string) {
  const uid = process.geteuid!();
  for (let parent = dirname(path);;) {
    const info = lstatSync(parent);
    check(info.isDirectory() && [uid, 0].includes(info.uid) && ((info.mode & 0o022) === 0 || (info.uid === 0 && Boolean(info.mode & 0o1000))), 'backup_parent_untrusted');
    if (dirname(parent) === parent) break; parent = dirname(parent);
  }
}
function privateFile(info: Stats, allowEmpty = false, maximum = MAX_DATABASE) {
  check(info.isFile() && info.nlink === 1 && info.uid === process.geteuid!() && (info.mode & 0o7177) === 0 && Boolean(info.mode & 0o400) && info.size >= (allowEmpty ? 0 : 1) && info.size <= maximum, 'backup_file_unsafe');
}
function sameFile(a: Stats, b: Stats, unchanged: boolean) {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && (!unchanged || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}
function pin(path: string, maximum = MAX_DATABASE, descriptorRelative = false): PinnedFile {
  if (!descriptorRelative) trustedParents(path);
  const before = lstatSync(path); privateFile(before, false, maximum);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = fstatSync(fd); privateFile(stat, false, maximum); check(sameFile(before, stat, true), 'backup_file_changed'); return { path, fd, stat }; }
  catch (error) { closeSync(fd); throw error; }
}
function safeSourceSidecars(path: string) {
  for (const suffix of ['-wal','-shm','-journal']) {
    let info: Stats; try { info = lstatSync(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    privateFile(info, true);
  }
}
function assertPinned(file: PinnedFile, unchanged = true) {
  const current = lstatSync(file.path), opened = fstatSync(file.fd); privateFile(current); privateFile(opened);
  check(sameFile(file.stat, current, unchanged) && sameFile(file.stat, opened, unchanged), 'backup_file_changed');
}
function hash(file: PinnedFile): string {
  const h = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0;
  try { for (;;) { const count = readSync(file.fd, buffer, 0, buffer.length, offset); if (!count) break; offset += count; check(offset <= MAX_DATABASE, 'backup_size_limit'); h.update(buffer.subarray(0, count)); } }
  finally { buffer.fill(0); }
  assertPinned(file); return h.digest('hex');
}
function openDatabase(path: string, readOnly: boolean) {
  const db = new DatabaseSync(path, { readOnly, allowExtension: false, enableDoubleQuotedStringLiterals: false, timeout: 5000 });
  try { db.enableDefensive(true); db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;'); return db; }
  catch (error) { db.close(); throw error; }
}
function inspect(db: DatabaseSync): SchemaSummary {
  check(db.prepare('PRAGMA user_version').get()?.user_version === 0 && db.prepare('PRAGMA application_id').get()?.application_id === 0, 'backup_product_schema_version_unsupported');
  check(db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'backup_integrity_failed');
  check(db.prepare('PRAGMA foreign_key_check').get() === undefined, 'backup_integrity_failed');
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  check(schema.length <= 128 && schema.every(row => ['table', 'index'].includes(row.type) && Object.hasOwn(columns, row.tbl_name) && !(row.sql && /\bVIRTUAL\b/i.test(row.sql))), 'backup_product_schema_unsupported');
  const tables = new Set(schema.filter(row => row.type === 'table').map(row => row.name));
  check(requiredTables.every(name => tables.has(name)), 'backup_product_schema_required');
  for (const name of tables) {
    check(Object.hasOwn(columns, name), 'backup_product_schema_unsupported');
    const actual = db.prepare(`PRAGMA table_xinfo(${name})`).all() as Array<{ name: string; hidden: number }>;
    check(actual.every(column => column.hidden === 0) && actual.map(column => column.name).join(',') === columns[name], 'backup_product_schema_unsupported');
  }
  const size = db.prepare('SELECT count(*) AS count, max(length(value_json)) AS size FROM runtime_binding').get() as { count: number; size: number };
  check(size.count === 1 && size.size > 0 && size.size <= 8192, 'backup_product_binding_required');
  const encoded = db.prepare('SELECT value_json FROM runtime_binding WHERE singleton=1').get()?.value_json;
  check(typeof encoded === 'string', 'backup_product_binding_required');
  let binding: unknown; try { binding = JSON.parse(encoded as string); } catch { throw new ProductBackupError('backup_product_binding_invalid'); }
  check(exact(binding, ['userId','agentId','contextId','sessionId','principalId','runtimeOrigin','verified','createdAt']), 'backup_product_binding_invalid');
  const b = binding as Record<string, unknown>;
  check(['userId','agentId','contextId','sessionId'].every(key => identifier(b[key])) && (b.principalId === null || identifier(b.principalId)) && typeof b.verified === 'boolean' && Number.isSafeInteger(b.createdAt), 'backup_product_binding_invalid');
  let runtime: URL; try { runtime = new URL(String(b.runtimeOrigin)); } catch { throw new ProductBackupError('backup_product_binding_invalid'); }
  check(['http:','https:'].includes(runtime.protocol) && ['127.0.0.1','localhost','[::1]'].includes(runtime.hostname) && runtime.origin === b.runtimeOrigin, 'backup_product_binding_invalid');
  const authCount = authTables.filter(name => tables.has(name)).length;
  check(authCount === 0 || authCount === authTables.length, 'backup_auth_schema_invalid');
  let ownerAuthentication = false;
  if (authCount) {
    const states = db.prepare('SELECT singleton,owner_id,origin,config_hash,generation FROM auth_owner_state').all();
    check(states.length === 1, 'backup_auth_state_invalid');
    const state = states[0];
    check(state.singleton === 1 && state.owner_id === b.userId && typeof state.origin === 'string' && state.origin.length <= 2048 && typeof state.config_hash === 'string' && /^[a-f0-9]{64}$/.test(state.config_hash) && Number.isSafeInteger(state.generation) && Number(state.generation) >= 1 && Number(state.generation) < Number.MAX_SAFE_INTEGER, 'backup_auth_state_invalid');
    let origin: URL; try { origin = new URL(String(state.origin)); } catch { throw new ProductBackupError('backup_auth_state_invalid'); }
    check(origin.origin === state.origin && (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname))), 'backup_auth_state_invalid');
    ownerAuthentication = true;
  }
  return { schemaSha256: digest(JSON.stringify(schema)), identitySha256: digest(encoded as string), ownerAuthentication };
}
function privateDirectory(raw: string): PinnedDirectory {
  const path = selectedPath(raw); trustedParents(path); const before = lstatSync(path);
  check(before.isDirectory() && before.uid === process.geteuid!() && (before.mode & 0o077) === 0, 'backup_directory_unsafe');
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); check(stat.isDirectory() && sameFile(before, stat, true), 'backup_directory_changed');
    // Linux descriptor-relative pathname: SQLite can still create its own
    // journal files, but a rename/replacement of the selected directory cannot
    // redirect writes into the new pathname target. No user-supplied proc path.
    return { path, fd, stat, anchor: `/proc/self/fd/${fd}` };
  } catch (error) { closeSync(fd); throw error; }
}
function newDirectory(raw: string): PinnedDirectory {
  const path = selectedPath(raw); trustedParents(path); mkdirSync(path, { mode: 0o700 }); return privateDirectory(path);
}
function assertDirectory(directory: PinnedDirectory) {
  let current: Stats; try { current = lstatSync(directory.path); } catch { throw new ProductBackupError('backup_directory_changed'); }
  const opened = fstatSync(directory.fd);
  check(current.isDirectory() && opened.isDirectory() && sameFile(directory.stat, current, false) && sameFile(directory.stat, opened, false), 'backup_directory_changed');
}
function syncDirectory(directory: PinnedDirectory) { fsyncSync(directory.fd); assertDirectory(directory); }
function writeNew(directory: PinnedDirectory, name: string, value: unknown) {
  assertDirectory(directory);
  const fd = openSync(join(directory.anchor, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  assertDirectory(directory);
}
async function copyDatabase(source: DatabaseSync, directory: PinnedDirectory) {
  assertDirectory(directory);
  const path = join(directory.anchor, STAGING), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), before = fstatSync(fd);
  const pageSize = Number(source.prepare('PRAGMA page_size').get()?.page_size), began = Date.now();
  try {
    await backup(source, path, { rate: 100, progress: ({ totalPages }) => { check(totalPages * pageSize <= MAX_DATABASE, 'backup_size_limit'); check(Date.now() - began <= 120_000, 'backup_time_limit'); } });
    const current = lstatSync(path); privateFile(current); check(sameFile(before, current, false), 'backup_destination_changed'); fsyncSync(fd); assertDirectory(directory);
  } catch (error) {
    // SQLite may reject an interrupted directory rename before its promise
    // reaches our normal post-copy check. Preserve the same safe classification.
    assertDirectory(directory); throw error;
  } finally { closeSync(fd); }
  return path;
}
function publish(directory: PinnedDirectory, staging: string) {
  assertDirectory(directory);
  const destination = join(directory.anchor, DATABASE);
  // link is exclusive: unlike rename or sqlite.backup, it never replaces a file.
  linkSync(staging, destination); unlinkSync(staging); syncDirectory(directory); return destination;
}
function parseManifest(value: unknown): ProductSnapshotManifest {
  check(exact(value, ['format','version','createdAt','database','schemaSha256','identitySha256','ownerAuthentication']), 'backup_manifest_invalid');
  const m = value as Record<string, unknown>, database = m.database as Record<string, unknown>;
  check(m.format === 'opendots-product-snapshot' && m.version === 1 && typeof m.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.createdAt) && Number.isFinite(Date.parse(m.createdAt)) && typeof m.ownerAuthentication === 'boolean', 'backup_manifest_invalid');
  check(exact(database, ['file','bytes','sha256']) && database.file === DATABASE && Number.isSafeInteger(database.bytes) && Number(database.bytes) > 0 && Number(database.bytes) <= MAX_DATABASE && [database.sha256,m.schemaSha256,m.identitySha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'backup_manifest_invalid');
  return value as ProductSnapshotManifest;
}
function openSnapshot(raw: string) {
  const directory = privateDirectory(raw);
  let manifestFile: PinnedFile | undefined, databaseFile: PinnedFile | undefined, db: DatabaseSync | undefined;
  try {
    check(readdirSync(directory.anchor).sort().join(',') === [MANIFEST,DATABASE].sort().join(','), 'backup_snapshot_files_invalid');
    manifestFile = pin(join(directory.anchor, MANIFEST), MAX_MANIFEST, true);
    let value: unknown; try { value = JSON.parse(readFileSync(manifestFile.fd, 'utf8')); } catch { throw new ProductBackupError('backup_manifest_invalid'); }
    const manifest = parseManifest(value); assertPinned(manifestFile);
    databaseFile = pin(join(directory.anchor, DATABASE), MAX_DATABASE, true);
    check(databaseFile.stat.size === manifest.database.bytes && hash(databaseFile) === manifest.database.sha256, 'backup_hash_mismatch');
    db = openDatabase(databaseFile.path, true); assertPinned(databaseFile);
    const actual = inspect(db);
    check(actual.schemaSha256 === manifest.schemaSha256 && actual.identitySha256 === manifest.identitySha256 && actual.ownerAuthentication === manifest.ownerAuthentication, 'backup_manifest_mismatch');
    const recheck = () => {
      assertDirectory(directory); assertPinned(manifestFile!); assertPinned(databaseFile!);
      check(readdirSync(directory.anchor).sort().join(',') === [MANIFEST,DATABASE].sort().join(',') && hash(databaseFile!) === manifest.database.sha256, 'backup_snapshot_changed');
    };
    return { directory, db, manifest, recheck, close: () => { db!.close(); closeSync(databaseFile!.fd); closeSync(manifestFile!.fd); closeSync(directory.fd); } };
  } catch (error) { db?.close(); if (databaseFile) closeSync(databaseFile.fd); if (manifestFile) closeSync(manifestFile.fd); closeSync(directory.fd); throw error; }
}
function failure(error: unknown): never { throw error instanceof ProductBackupError ? error : new ProductBackupError('backup_operation_failed'); }

/** Snapshot only the explicitly selected product DB. SQLite copies committed WAL
 * state consistently; no host services, config readers or Runtime adapters run. */
export async function createProductSnapshot(input: { source: string; destination: string }): Promise<SnapshotResult> {
  let sourceFile: PinnedFile | undefined, source: DatabaseSync | undefined, directory: PinnedDirectory | undefined;
  try {
    sourceFile = pin(selectedPath(input.source)); safeSourceSidecars(sourceFile.path); source = openDatabase(sourceFile.path, true); assertPinned(sourceFile, false); inspect(source);
    directory = newDirectory(input.destination); const staging = await copyDatabase(source, directory);
    assertPinned(sourceFile, false);
    const copied = openDatabase(staging, false); let summary: SchemaSummary;
    try { copied.exec('PRAGMA journal_mode=DELETE;'); summary = inspect(copied); } finally { copied.close(); }
    const published = publish(directory, staging), file = pin(published, MAX_DATABASE, true);
    let manifest: ProductSnapshotManifest;
    try { manifest = { format: 'opendots-product-snapshot', version: 1, createdAt: new Date().toISOString(), database: { file: DATABASE, bytes: file.stat.size, sha256: hash(file) }, ...summary }; }
    finally { closeSync(file.fd); }
    writeNew(directory, MANIFEST, manifest); syncDirectory(directory);
    return { directory: directory.path, databasePath: join(directory.path, DATABASE), manifestPath: join(directory.path, MANIFEST), manifest };
  } catch (error) { return failure(error); }
  finally { source?.close(); if (sourceFile) closeSync(sourceFile.fd); if (directory) closeSync(directory.fd); }
}

export function verifyProductSnapshot(directory: string): ProductSnapshotManifest {
  let snapshot: ReturnType<typeof openSnapshot> | undefined;
  try { snapshot = openSnapshot(directory); snapshot.recheck(); return snapshot.manifest; }
  catch (error) { return failure(error); }
  finally { snapshot?.close(); }
}

/** Restore publishes only a new private directory. The operator declaration is
 * required but is not process detection. Never replaces or starts an app. */
export async function restoreProductSnapshot(input: { snapshot: string; destination: string; appStopped: boolean }): Promise<RestoreResult> {
  let snapshot: ReturnType<typeof openSnapshot> | undefined, directory: PinnedDirectory | undefined;
  try {
    check(input.appStopped === true, 'backup_app_stopped_acknowledgment_required');
    snapshot = openSnapshot(input.snapshot);
    directory = newDirectory(input.destination); const staging = await copyDatabase(snapshot.db, directory);
    snapshot.recheck();
    const restored = openDatabase(staging, false); let invalidatedSessions = 0;
    try {
      restored.exec('PRAGMA journal_mode=DELETE;');
      const before = inspect(restored);
      check(before.schemaSha256 === snapshot.manifest.schemaSha256 && before.identitySha256 === snapshot.manifest.identitySha256, 'backup_restored_binding_mismatch');
      if (before.ownerAuthentication) {
        restored.exec('BEGIN IMMEDIATE');
        try {
          invalidatedSessions = Number(restored.prepare('DELETE FROM auth_device_sessions').run().changes);
          restored.prepare('UPDATE auth_owner_state SET generation=generation+1 WHERE singleton=1').run();
          restored.exec('COMMIT');
        } catch (error) { restored.exec('ROLLBACK'); throw error; }
      }
      const after = inspect(restored);
      check(after.schemaSha256 === before.schemaSha256 && after.identitySha256 === before.identitySha256 && after.ownerAuthentication === before.ownerAuthentication, 'backup_restored_binding_mismatch');
    } finally { restored.close(); }
    snapshot.recheck();
    const published = publish(directory, staging), file = pin(published, MAX_DATABASE, true); let restoredSha256: string;
    try { restoredSha256 = hash(file); } finally { closeSync(file.fd); }
    writeNew(directory, 'restore.json', { format: 'opendots-product-restore', version: 1, restoredAt: new Date().toISOString(), snapshotSha256: snapshot.manifest.database.sha256, restoredSha256, invalidatedSessions, ownerAuthentication: snapshot.manifest.ownerAuthentication, reconnectPerformed: false });
    syncDirectory(directory);
    return { directory: directory.path, databasePath: join(directory.path, DATABASE), receiptPath: join(directory.path, 'restore.json'), invalidatedSessions, ownerAuthentication: snapshot.manifest.ownerAuthentication };
  } catch (error) { return failure(error); }
  finally { snapshot?.close(); if (directory) closeSync(directory.fd); }
}
