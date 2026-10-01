import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export interface NativeAttachmentStage {
  stage_id: string; principal_id: string; session_id: string; client_message_id: string;
  name: string; media_type: string; size_bytes: number; offset: number;
  expected_sha256: string | null; sha256: string | null;
  status: 'uploading' | 'ready' | 'consumed'; created_at: string; expires_at: string;
  consumed_event_id: string | null;
}
export interface AttachmentStageDeclaration {
  stage_id: string; client_message_id: string; name: string; media_type: string;
  size_bytes: number; expected_sha256: string;
}
export interface AttachmentStageAdapter {
  createAttachmentStage(sessionId: string, input: AttachmentStageDeclaration): Promise<NativeAttachmentStage>;
  getAttachmentStage(sessionId: string, stageId: string): Promise<NativeAttachmentStage>;
  uploadAttachmentStage(sessionId: string, stageId: string, offset: number, bytes: Uint8Array): Promise<NativeAttachmentStage>;
  cancelAttachmentStage(sessionId: string, stageId: string): Promise<void>;
}
export interface AttachmentUploadInput { draftKey: string; uploadKey: string; name: string; mediaType: string; sizeBytes: number; sha256: string }
export interface AttachmentUploadBinding { userId: string; principalId: string; sessionId: string }
export class AttachmentUploadError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const attachmentUploadLimits = { maximumBytes: 10 * 1024 * 1024, maximumChunkBytes: 256 * 1024, maximumFiles: 4, maximumDraftBytes: 20 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'] } as const;
type Status = 'pending' | 'uploading' | 'ready' | 'consumed' | 'unknown' | 'missing' | 'cancelling' | 'cancelled';
interface Row { id: string; upload_key: string; draft_key: string; stage_id: string; fingerprint: string; declaration_json: string; status: Status; receipt_json: string | null; error_code: string | null; created_at: number; updated_at: number }
interface Draft { draft_key: string; client_message_id: string; sealed_command_key: string | null; sealed_fingerprint: string | null; sealed_ids_json: string | null }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const errorStatus = (error: unknown) => (error as { status?: number })?.status;
const fail = (status: number, code: string, message: string): never => { throw new AttachmentUploadError(status, code, message); };

/** Draft byte transfer only. Native stages are not committed resources, model
 * inputs or deliveries. A separate exact typed message commit supplies authority.
 * The product persists metadata/receipts, never an extra copy of file bytes.
 */
export class AttachmentUploads {
  readonly db: DatabaseSync;
  private ownDatabase: boolean;
  private adapter: AttachmentStageAdapter;
  private binding: AttachmentUploadBinding;
  private locks = new Map<string, Promise<void>>();
  constructor(database: DatabaseSync | string, adapter: AttachmentStageAdapter, binding: AttachmentUploadBinding) {
    if (![binding.userId, binding.principalId, binding.sessionId].every(value => typeof value === 'string' && value.length > 0 && value.length < 2048)) fail(500, 'binding_required', 'A fixed attachment user, Principal and Session are required');
    this.db = typeof database === 'string' ? new DatabaseSync(database) : database;
    this.ownDatabase = typeof database === 'string'; this.adapter = adapter;
    this.binding = { userId: binding.userId, principalId: binding.principalId, sessionId: binding.sessionId };
    try {
      this.db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS attachment_upload_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),binding_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attachment_drafts(draft_key TEXT PRIMARY KEY,client_message_id TEXT NOT NULL UNIQUE,sealed_command_key TEXT,sealed_fingerprint TEXT,sealed_ids_json TEXT);
        CREATE TABLE IF NOT EXISTS attachment_uploads(id TEXT PRIMARY KEY,upload_key TEXT NOT NULL UNIQUE,draft_key TEXT NOT NULL,stage_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,declaration_json TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS attachment_upload_drafts ON attachment_uploads(draft_key,created_at,id);`);
      this.transaction(() => {
        const row = this.db.prepare('SELECT binding_json FROM attachment_upload_binding WHERE singleton=1').get() as { binding_json: string } | undefined;
        const encoded = JSON.stringify(this.binding);
        if (row && row.binding_json !== encoded) fail(409, 'binding_conflict', 'Attachment metadata belongs to another user or Session');
        if (!row) this.db.prepare('INSERT INTO attachment_upload_binding VALUES(1,?)').run(encoded);
      });
    } catch (error) { if (this.ownDatabase) this.db.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    if (this.db.isTransaction) fail(500, 'nested_transaction', 'Use seal only inside the command transaction');
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private async lock<T>(draftKey: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.locks.get(draftKey) ?? Promise.resolve();
    const result = preceding.then(operation);
    const tail = result.then(() => undefined, () => undefined); this.locks.set(draftKey, tail);
    void tail.then(() => { if (this.locks.get(draftKey) === tail) this.locks.delete(draftKey); });
    return result;
  }
  private row(id: string): Row { return this.db.prepare('SELECT * FROM attachment_uploads WHERE id=?').get(id) as unknown as Row ?? fail(404, 'upload_not_found', 'Attachment upload not found in this Session'); }
  private draft(draftKey: string): Draft { return this.db.prepare('SELECT * FROM attachment_drafts WHERE draft_key=?').get(draftKey) as unknown as Draft ?? fail(404, 'draft_not_found', 'Attachment draft not found in this Session'); }
  private declarationOf(row: Row): AttachmentStageDeclaration { return JSON.parse(row.declaration_json); }
  private view(row: Row) {
    const declaration = this.declarationOf(row); const receipt: NativeAttachmentStage | undefined = row.receipt_json ? JSON.parse(row.receipt_json) : undefined;
    return { id: row.id, uploadKey: row.upload_key, draftKey: row.draft_key, name: declaration.name, mediaType: declaration.media_type, sizeBytes: declaration.size_bytes, sha256: declaration.expected_sha256,
      status: row.status, offset: receipt?.offset ?? 0, expiresAt: receipt?.expires_at ?? null, consumedEventId: receipt?.consumed_event_id ?? null,
      errorCode: row.error_code, stagedOnly: row.status !== 'consumed', sealed: this.draft(row.draft_key).sealed_command_key !== null };
  }
  private state(id: string, status: Status, errorCode: string | null = null) { this.db.prepare('UPDATE attachment_uploads SET status=?,error_code=?,updated_at=? WHERE id=?').run(status, errorCode, Date.now(), id); }
  private checked(row: Row, received: NativeAttachmentStage): NativeAttachmentStage {
    const d = this.declarationOf(row);
    if (!received || received.stage_id !== row.stage_id || received.session_id !== this.binding.sessionId || received.principal_id !== this.binding.principalId || received.client_message_id !== d.client_message_id || received.name !== d.name || received.media_type !== d.media_type || received.size_bytes !== d.size_bytes || received.expected_sha256 !== d.expected_sha256) fail(502, 'native_scope_conflict', 'Native attachment identity or declaration does not match the saved draft');
    if (!['uploading', 'ready', 'consumed'].includes(received.status) || !Number.isSafeInteger(received.offset) || received.offset < 0 || received.offset > d.size_bytes || !Number.isFinite(Date.parse(received.created_at)) || !Number.isFinite(Date.parse(received.expires_at))) fail(502, 'native_receipt_invalid', 'Native attachment receipt is invalid');
    if ((received.sha256 !== null && received.sha256 !== d.expected_sha256) || (received.status !== 'uploading' && (received.offset !== d.size_bytes || received.sha256 !== d.expected_sha256))) fail(502, 'native_integrity_conflict', 'Native attachment size or digest is not verified');
    if (received.status !== 'consumed' && received.consumed_event_id !== null) fail(502, 'native_receipt_invalid', 'An unconsumed stage cannot claim Event ownership');
    if (received.status === 'consumed' && (typeof received.consumed_event_id !== 'string' || !received.consumed_event_id || received.consumed_event_id.length > 2048)) fail(502, 'native_receipt_invalid', 'Consumed attachment lacks an owning Event');
    // Whitelist only public native fields; never persist a returned storage path.
    return { stage_id: received.stage_id, principal_id: received.principal_id, session_id: received.session_id, client_message_id: received.client_message_id, name: received.name, media_type: received.media_type, size_bytes: received.size_bytes, offset: received.offset, expected_sha256: received.expected_sha256, sha256: received.sha256, status: received.status, created_at: received.created_at, expires_at: received.expires_at, consumed_event_id: received.consumed_event_id ?? null };
  }
  private record(row: Row, received: NativeAttachmentStage) {
    const receipt = this.checked(row, received);
    this.db.prepare('UPDATE attachment_uploads SET status=?,receipt_json=?,error_code=NULL,updated_at=? WHERE id=?').run(receipt.status, JSON.stringify(receipt), Date.now(), row.id);
    return receipt;
  }
  private async inspect(row: Row) {
    try {
      const receipt = this.record(row, await this.adapter.getAttachmentStage(this.binding.sessionId, row.stage_id));
      if (row.status === 'cancelling' && receipt.status !== 'consumed') this.state(row.id, 'cancelling', 'cancel_unconfirmed');
      return receipt;
    } catch (error) {
      const previous = row.receipt_json ? JSON.parse(row.receipt_json) as NativeAttachmentStage : undefined;
      // Stage TTL cannot erase the already observed immutable Event ownership.
      if (previous?.status === 'consumed') {
        this.state(row.id, 'consumed', errorStatus(error) === 404 ? 'native_stage_missing' : 'native_read_unconfirmed');
        if (errorStatus(error) === 404) return previous;
      } else if (errorStatus(error) === 404) this.state(row.id, row.status === 'cancelling' ? 'cancelled' : 'missing', 'native_stage_missing');
      else if (row.status === 'cancelling') this.state(row.id, 'cancelling', 'cancel_unconfirmed');
      else this.state(row.id, 'unknown', error instanceof AttachmentUploadError ? error.code : 'native_read_unconfirmed');
      throw error;
    }
  }
  private editable(draftKey: string) { if (this.draft(draftKey).sealed_command_key) fail(409, 'draft_sealed', 'This draft is already bound to a message command. Retry that exact command.'); }
  private validate(input: AttachmentUploadInput) {
    if (!input || Object.keys(input).some(field => !['draftKey','uploadKey','name','mediaType','sizeBytes','sha256'].includes(field)) || !key(input.draftKey) || !key(input.uploadKey)) fail(400, 'invalid_declaration', 'Stable draft and upload keys are required');
    if (typeof input.name !== 'string' || !input.name.trim() || [...input.name].length > 255 || input.name !== input.name.trim() || /[\\/\x00-\x1f\x7f]/.test(input.name)) fail(400, 'invalid_name', 'Use a filename, not a filesystem path or URL');
    if (!attachmentUploadLimits.mediaTypes.includes(input.mediaType as any)) fail(415, 'unsupported_media_type', 'Initial uploads support PNG, JPEG, PDF and plain text');
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > attachmentUploadLimits.maximumBytes || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) fail(400, 'invalid_size_or_hash', 'A 1-byte through 10-MiB file and its lowercase SHA-256 are required');
  }
  async create(input: AttachmentUploadInput) {
    this.validate(input); const fingerprint = digest([input.draftKey, input.name, input.mediaType, input.sizeBytes, input.sha256]);
    const row = this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM attachment_uploads WHERE upload_key=?').get(input.uploadKey) as unknown as Row | undefined;
      if (existing) { if (existing.fingerprint !== fingerprint) fail(409, 'upload_key_conflict', 'Upload key already names different bytes or draft'); return existing; }
      let draft = this.db.prepare('SELECT * FROM attachment_drafts WHERE draft_key=?').get(input.draftKey) as unknown as Draft | undefined;
      if (!draft) { const client = `attachment-message-${digest([this.binding.userId, this.binding.sessionId, input.draftKey])}`; this.db.prepare('INSERT INTO attachment_drafts VALUES(?,?,NULL,NULL,NULL)').run(input.draftKey, client); draft = this.draft(input.draftKey); }
      this.editable(input.draftKey);
      const rows = this.db.prepare("SELECT * FROM attachment_uploads WHERE draft_key=? AND status!='cancelled'").all(input.draftKey) as unknown as Row[];
      if (rows.length >= attachmentUploadLimits.maximumFiles || rows.reduce((sum, row) => sum + this.declarationOf(row).size_bytes, 0) + input.sizeBytes > attachmentUploadLimits.maximumDraftBytes) fail(413, 'draft_limit', 'A draft supports at most four files and 20 MiB total');
      const id = `upload-${randomUUID()}`; const stage = `stage-${randomUUID()}`; const now = Date.now();
      const declaration: AttachmentStageDeclaration = { stage_id: stage, client_message_id: draft.client_message_id, name: input.name, media_type: input.mediaType, size_bytes: input.sizeBytes, expected_sha256: input.sha256 };
      this.db.prepare("INSERT INTO attachment_uploads VALUES(?,?,?,?,?,?,'pending',NULL,NULL,?,?)").run(id, input.uploadKey, input.draftKey, stage, fingerprint, JSON.stringify(declaration), now, now);
      return this.row(id);
    });
    return this.lock(row.draft_key, async () => {
      if (this.draft(row.draft_key).sealed_command_key) return this.view(this.row(row.id));
      if (['cancelled','cancelling'].includes(this.row(row.id).status)) fail(409, 'upload_cancelled', 'This upload was cancelled; use an explicit new upload action');
      const observed = this.row(row.id);
      try { await this.inspect(observed); }
      catch (error) {
        if (errorStatus(error) !== 404) throw new AttachmentUploadError(503, 'create_unconfirmed', 'Cannot confirm the native stage. Retry with the same upload key.');
        // A previously observed stage disappearing means expiry/removal, not permission to replace it.
        if (observed.receipt_json) fail(410, 'native_stage_missing', 'The native stage expired or was removed. No replacement was created.');
        try { this.record(row, await this.adapter.createAttachmentStage(this.binding.sessionId, this.declarationOf(row))); }
        catch (error) { this.state(row.id, 'unknown', 'create_unconfirmed'); throw new AttachmentUploadError(errorStatus(error) === 409 ? 409 : 503, 'create_unconfirmed', 'Stage creation is unconfirmed. Retry the same upload key; no new identity was allocated.'); }
      }
      return this.view(this.row(row.id));
    });
  }
  list(draftKey?: string) {
    if (draftKey !== undefined && !key(draftKey)) fail(400, 'invalid_draft', 'Invalid draft key');
    const rows = (draftKey === undefined ? this.db.prepare('SELECT * FROM attachment_uploads ORDER BY created_at,id').all() : this.db.prepare('SELECT * FROM attachment_uploads WHERE draft_key=? ORDER BY created_at,id').all(draftKey)) as unknown as Row[];
    return rows.map(row => this.view(row));
  }
  async reconcile(id: string) {
    const row = this.row(id); return this.lock(row.draft_key, async () => {
      const current = this.row(id); if (current.status === 'cancelled') return this.view(current);
      try { await this.inspect(current); }
      catch (error) { if (errorStatus(error) !== 404) throw new AttachmentUploadError(503, 'native_read_unconfirmed', 'Cannot confirm native upload state; saved identity is retained'); }
      return this.view(this.row(id));
    });
  }
  async upload(id: string, offset: number, bytes: Uint8Array) {
    const row = this.row(id); const declaration = this.declarationOf(row);
    if (!Number.isSafeInteger(offset) || offset < 0 || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > attachmentUploadLimits.maximumChunkBytes || offset + bytes.byteLength > declaration.size_bytes) fail(400, 'invalid_chunk', 'Provide a bounded byte chunk at a valid offset');
    return this.lock(row.draft_key, async () => {
      this.editable(row.draft_key); const current = this.row(id);
      if (['cancelled','cancelling'].includes(current.status)) fail(409, 'upload_cancelled', 'This upload was cancelled');
      let native: NativeAttachmentStage;
      try { native = await this.inspect(current); } catch { throw new AttachmentUploadError(503, 'native_read_unconfirmed', 'Read the existing stage before resuming; no bytes were resent'); }
      if (native.status !== 'uploading') return this.view(this.row(id));
      if (native.offset !== offset) fail(409, 'offset_conflict', 'Native upload offset changed. Reconcile and resume from the reported offset.');
      this.state(id, 'unknown', 'upload_in_flight');
      try { this.record(current, await this.adapter.uploadAttachmentStage(this.binding.sessionId, row.stage_id, offset, bytes)); }
      catch (error) {
        this.state(id, 'unknown', 'upload_unconfirmed');
        // A lost write response can still be reconciled by native file length/digest.
        // Never resend bytes or fabricate a new stage here.
        try { const confirmed = await this.inspect(current); if (confirmed.status === 'ready' || confirmed.status === 'consumed') return this.view(this.row(id)); } catch { /* preserve the exact pending identity */ }
        throw new AttachmentUploadError(errorStatus(error) === 409 ? 409 : 503, 'upload_unconfirmed', 'Upload outcome is unconfirmed. Reconcile and resume the same file and stage.');
      }
      return this.view(this.row(id));
    });
  }
  async cancel(id: string) {
    const row = this.row(id); return this.lock(row.draft_key, async () => {
      const current = this.row(id); if (current.status === 'cancelled') return this.view(current);
      const draft = this.draft(row.draft_key);
      if (draft.sealed_ids_json && (JSON.parse(draft.sealed_ids_json) as string[]).includes(id)) fail(409, 'draft_sealed', 'A message-bound attachment cannot be cancelled as a draft');
      try { const native = await this.inspect(current); if (native.status === 'consumed') fail(409, 'stage_consumed', 'A committed Event-owned resource cannot be cancelled as a draft'); }
      catch (error) {
        if (errorStatus(error) === 404) {
          const latest = this.draft(row.draft_key);
          if (latest.sealed_ids_json && (JSON.parse(latest.sealed_ids_json) as string[]).includes(id)) fail(409, 'draft_sealed', 'A message-bound attachment cannot be cancelled as a draft');
          this.state(id, 'cancelled'); return this.view(this.row(id));
        }
        throw error;
      }
      // prepareSend releases its async lock before RuntimeStore's synchronous seal.
      // Recheck after the awaited native read; no await may separate this fence
      // from marking cancellation in flight (which seal rejects as not ready).
      const latestDraft = this.draft(row.draft_key);
      if (latestDraft.sealed_ids_json && (JSON.parse(latestDraft.sealed_ids_json) as string[]).includes(id)) fail(409, 'draft_sealed', 'A message-bound attachment cannot be cancelled as a draft');
      this.state(id, 'cancelling', 'cancel_unconfirmed');
      try { await this.adapter.cancelAttachmentStage(this.binding.sessionId, row.stage_id); this.state(id, 'cancelled'); }
      catch (error) {
        if (errorStatus(error) === 404) this.state(id, 'cancelled');
        else { try { await this.adapter.getAttachmentStage(this.binding.sessionId, row.stage_id); } catch (readError) { if (errorStatus(readError) === 404) { this.state(id, 'cancelled'); return this.view(this.row(id)); } } throw new AttachmentUploadError(503, 'cancel_unconfirmed', 'Draft cancellation is unconfirmed. Retry the same upload identity.'); }
      }
      return this.view(this.row(id));
    });
  }
  private selected(draftKey: string, ids: string[]) {
    if (!key(draftKey) || !Array.isArray(ids) || ids.length < 1 || ids.length > attachmentUploadLimits.maximumFiles || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) fail(400, 'invalid_selection', 'Select one through four exact uploaded file identities');
    const draft = this.draft(draftKey); const rows = ids.map(id => this.row(id));
    if (rows.some(row => row.draft_key !== draftKey)) fail(403, 'foreign_draft', 'An attachment belongs to another draft');
    if (draft.sealed_ids_json && draft.sealed_ids_json !== JSON.stringify(ids)) fail(409, 'draft_sealed', 'The sealed attachment order cannot be changed');
    return { draft, rows };
  }
  async prepareSend(draftKey: string, ids: string[]) {
    return this.lock(draftKey, async () => {
      const { draft, rows } = this.selected(draftKey, ids);
      if (!draft.sealed_command_key) for (const row of rows) {
        if (['cancelled','cancelling','missing'].includes(row.status)) fail(409, 'stage_not_ready', 'Every selected file must have a live ready stage');
        let native: NativeAttachmentStage;
        try { native = await this.inspect(row); } catch { throw new AttachmentUploadError(503, 'native_read_unconfirmed', 'Cannot confirm attachment readiness; no message was submitted'); }
        if (native.status !== 'ready' || Date.parse(native.expires_at) <= Date.now()) fail(409, 'stage_not_ready', 'Every selected file must have a live ready stage');
      }
      return { clientMessageId: draft.client_message_id, attachments: rows.map(row => ({ stage_id: row.stage_id })) };
    });
  }
  /** Must run synchronously inside RuntimeStore.prepare's own transaction.
   * Never acquires a nested transaction or performs network I/O. */
  seal(draftKey: string, ids: string[], commandKey: string, fingerprint: string) {
    if (!this.db.isTransaction) fail(500, 'transaction_required', 'Seal and command persistence must share the same SQLite transaction');
    if (!key(commandKey) || !/^[a-f0-9]{64}$/.test(fingerprint)) fail(400, 'invalid_seal', 'Stable command identity and content fingerprint are required');
    const { draft, rows } = this.selected(draftKey, ids);
    if (draft.sealed_command_key) {
      if (draft.sealed_command_key !== commandKey || draft.sealed_fingerprint !== fingerprint) fail(409, 'sealed_command_conflict', 'This draft is sealed to a different command or content');
      return;
    }
    if (rows.some(row => row.status !== 'ready' || !row.receipt_json || Date.parse((JSON.parse(row.receipt_json) as NativeAttachmentStage).expires_at) <= Date.now())) fail(409, 'stage_not_ready', 'Attachment state changed before the message was saved');
    this.db.prepare('UPDATE attachment_drafts SET sealed_command_key=?,sealed_fingerprint=?,sealed_ids_json=? WHERE draft_key=?').run(commandKey, fingerprint, JSON.stringify(ids), draftKey);
  }
  close() { if (this.ownDatabase) this.db.close(); }
}
