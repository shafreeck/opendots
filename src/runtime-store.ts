import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { IoEvent, IoEventPage, RuntimeObjective, RuntimeApproval, RuntimeSession } from './morphz-adapter.ts';
import { ConflictError, MissingError } from './store.ts';

export interface UserBinding {
  userId: string; agentId: string; contextId: string; sessionId: string; principalId: string | null;
  runtimeOrigin: string; verified: boolean; createdAt: number;
}
export type CommandKind = 'chat' | 'objective' | 'objective_input' | 'objective_control' | 'approval' | 'turn_cancel';
export interface InputCommand {
  id: string; key: string; kind: CommandKind; payload: Record<string, unknown>; payloadHash: string;
  status: 'pending' | 'submitting' | 'accepted' | 'unknown' | 'rejected'; receipt: unknown;
  errorCode: string | null; attempts: number; createdAt: number; updatedAt: number;
}
const parse = <T>(row: any, key = 'value_json'): T | undefined => row ? JSON.parse(row[key]) as T : undefined;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Product facts only. Runtime owns cognition, execution and permission state.
 * Commands are written before network I/O. IO cursors advance in the same transaction
 * as durable history; receipt cursors never enter the history checkpoint.
 */
export class RuntimeStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runtime_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_commands (id TEXT PRIMARY KEY, command_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, receipt_json TEXT, error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_control_links (predecessor_id TEXT PRIMARY KEY REFERENCES runtime_commands(id), successor_id TEXT NOT NULL UNIQUE REFERENCES runtime_commands(id));
      CREATE TABLE IF NOT EXISTS runtime_io_events (session_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(session_id,event_id),UNIQUE(session_id,sequence));
      CREATE TABLE IF NOT EXISTS runtime_io_cursors (session_id TEXT PRIMARY KEY,cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_views (kind TEXT NOT NULL,id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS runtime_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,command_id TEXT,created_at INTEGER NOT NULL);
    `);
    // A process exit cannot prove the upstream did not receive a request.
    this.db.prepare("UPDATE runtime_commands SET status='unknown',error_code='host_restarted' WHERE status='submitting'").run();
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  binding(): UserBinding | undefined { return parse<UserBinding>(this.db.prepare('SELECT value_json FROM runtime_binding WHERE singleton=1').get()); }
  ensureBinding(runtimeOrigin: string): UserBinding {
    return this.transaction(() => {
      const existing = this.binding();
      if (existing) {
        if (existing.runtimeOrigin !== runtimeOrigin) throw new ConflictError('This database belongs to another Runtime origin. Use a separate data directory.');
        return existing;
      }
      const binding: UserBinding = { userId: `user-${randomUUID()}`, agentId: `agent-${randomUUID()}`, contextId: `context-${randomUUID()}`, sessionId: `session-${randomUUID()}`, principalId: null, runtimeOrigin, verified: false, createdAt: Date.now() };
      this.db.prepare('INSERT INTO runtime_binding VALUES(1,?)').run(JSON.stringify(binding));
      return binding;
    });
  }
  verifyBinding(session: RuntimeSession, principalId: string): UserBinding {
    const binding = this.binding();
    if (!binding || binding.sessionId !== session.id || binding.agentId !== session.agent_id || binding.contextId !== session.context_id || !principalId || (binding.principalId && binding.principalId !== principalId)) throw new ConflictError('Runtime identity does not match the saved local binding');
    const next = { ...binding, principalId, verified: true };
    this.db.prepare('UPDATE runtime_binding SET value_json=? WHERE singleton=1').run(JSON.stringify(next));
    return next;
  }
  prepare(kind: CommandKind, key: string, payload: Record<string, unknown>, beforeInsert?: (commandId: string) => void): InputCommand {
    const encoded = JSON.stringify(payload); const digest = hash(`${kind}\0${encoded}`);
    return this.transaction(() => {
      const existing = this.commandByKey(key);
      if (existing) { if (existing.payloadHash !== digest) throw new ConflictError('Idempotency key is already used for another request'); return existing; }
      const now = Date.now(); const id = `cmd-${randomUUID()}`;
      // Product-owned linked intents can be sealed atomically with this command.
      // Callback must be synchronous, use this same database, and perform no I/O.
      this.validateReplacement(kind, payload);
      beforeInsert?.(id);
      this.db.prepare("INSERT INTO runtime_commands (id,command_key,kind,payload_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)").run(id, key, kind, encoded, digest, now, now);
      if (kind === 'objective_control' && typeof payload.reviewedUnknownControlKey === 'string') {
        const predecessor = this.commandByKey(payload.reviewedUnknownControlKey)!;
        this.db.prepare('INSERT INTO runtime_control_links VALUES(?,?)').run(predecessor.id, id);
        this.audit('command.current_state_review', id);
      }
      this.audit('command.persisted', id);
      return this.command(id)!;
    });
  }
  private validateReplacement(kind: CommandKind, payload: Record<string, unknown>) {
    if (!['objective_control','approval','turn_cancel'].includes(kind)) return;
    const target = kind === 'objective_control' ? 'objectiveId' : kind === 'approval' ? 'approvalId' : 'rootTurnId';
    const pending = this.unresolvedCommands().filter(c => c.kind === kind && c.payload[target] === payload[target]);
    if (kind !== 'objective_control') {
      if (pending.length) throw new ConflictError('An unresolved original decision exists. Retry its exact key and decision; replacement is blocked.');
      return;
    }
    const key = payload.reviewedUnknownControlKey;
    if (key === undefined) {
      if (pending.some(c => !this.laterControlReview(c.id))) throw new ConflictError('An unresolved original control exists. Review that exact command before any new decision.');
      return;
    }
    const predecessor = typeof key === 'string' ? this.commandByKey(key) : undefined;
    if (!predecessor || predecessor.kind !== kind || predecessor.payload.objectiveId !== payload.objectiveId || predecessor.status !== 'unknown' || payload.acknowledgeUncertainOutcome !== true || !Number.isSafeInteger(payload.expectedRevision) || Number(payload.expectedRevision) <= Number(predecessor.payload.expectedRevision)) throw new ConflictError('A new control requires explicit review of the historical unknown outcome and an advanced native revision.');
    if (this.laterControlReview(predecessor.id) || pending.some(c => c.id !== predecessor.id && !this.laterControlReview(c.id))) throw new ConflictError('This unknown outcome already has a later control or another unresolved command.');
  }
  laterControlReview(id: string) {
    const row = this.db.prepare('SELECT successor_id FROM runtime_control_links WHERE predecessor_id=?').get(id) as {successor_id:string}|undefined;
    if (!row) return null;
    const next = this.command(row.successor_id)!;
    return { id: next.id, key: next.key, status: next.status, ambiguous: false };
  }
  unresolvedCommands(): InputCommand[] { return this.db.prepare("SELECT * FROM runtime_commands WHERE status IN ('pending','submitting','unknown') ORDER BY created_at,id").all().map(row => this.decode(row)!); }
  recoverableCommands(): InputCommand[] { return this.db.prepare("SELECT * FROM runtime_commands WHERE status IN ('pending','unknown') AND kind IN ('chat','objective','objective_input') ORDER BY created_at,id").all().map(row => this.decode(row)!); }
  publicCommand(command: InputCommand) {
    const {payloadHash: _, ...value} = command;
    const binding = this.binding(), receipt = command.receipt as {event_id?:string}|null;
    const event = binding && receipt?.event_id ? parse<IoEvent>(this.db.prepare('SELECT value_json FROM runtime_io_events WHERE session_id=? AND event_id=?').get(binding.sessionId, receipt.event_id)) : undefined;
    const objective = command.kind === 'objective' ? this.objectives().find(o => o.id === `objective-${command.id}`) : undefined;
    return {...value, laterControlReview: this.laterControlReview(command.id), observation: {acceptedInput: event?.type === 'input.accepted' ? {eventId:event.event_id, sequence:event.sequence} : null, projectedObjective: objective ? {id:objective.id,status:objective.status,revision:objective.revision} : null}};
  }
  commandLookup(key: string) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ConflictError('Invalid command key');
    const binding = this.binding(), command = this.commandByKey(key);
    return {authority:'local_command_ledger' as const,userId:binding?.userId??null,sessionId:binding?.sessionId??null,command:command ? this.publicCommand(command) : null};
  }
  commandByKey(key: string): InputCommand | undefined { return this.decode(this.db.prepare('SELECT * FROM runtime_commands WHERE command_key=?').get(key)); }
  command(id: string): InputCommand | undefined { return this.decode(this.db.prepare('SELECT * FROM runtime_commands WHERE id=?').get(id)); }
  private decode(row: any): InputCommand | undefined {
    return row && { id: row.id, key: row.command_key, kind: row.kind, payload: JSON.parse(row.payload_json), payloadHash: row.payload_hash, status: row.status, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, errorCode: row.error_code, attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  commands(): InputCommand[] { return this.db.prepare('SELECT * FROM runtime_commands ORDER BY created_at,id').all().map(row => this.decode(row)!); }
  attempted(id: string) {
    this.db.prepare("UPDATE runtime_commands SET status='submitting',attempts=attempts+1,error_code=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
    this.audit('command.dispatched', id);
  }
  record(id: string, status: InputCommand['status'], receipt: unknown = null, errorCode: string | null = null) {
    this.transaction(() => {
      if (!this.command(id)) throw new MissingError('Command not found');
      this.db.prepare('UPDATE runtime_commands SET status=?,receipt_json=?,error_code=?,updated_at=? WHERE id=?').run(status, receipt === null ? null : JSON.stringify(receipt), errorCode, Date.now(), id);
      this.audit(`command.${status}`, id);
    });
  }
  private audit(event: string, commandId: string) { this.db.prepare('INSERT INTO runtime_audit(event,command_id,created_at) VALUES(?,?,?)').run(event, commandId, Date.now()); }
  cursor(sessionId: string): string | undefined { return (this.db.prepare('SELECT cursor FROM runtime_io_cursors WHERE session_id=?').get(sessionId) as { cursor: string } | undefined)?.cursor; }
  ingest(sessionId: string, page: IoEventPage, expectedCursor?: string) {
    if (!Array.isArray(page.events) || typeof page.cursor !== 'string' || page.cursor.length > 4096) throw new Error('Invalid Runtime history page');
    this.transaction(() => {
      if (this.cursor(sessionId) !== expectedCursor) throw new ConflictError('History cursor changed during synchronization');
      for (const event of page.events) {
        if (!event.event_id || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || (event.session_id && event.session_id !== sessionId)) throw new Error('Invalid Runtime event scope or sequence');
        const existing = this.db.prepare('SELECT value_json FROM runtime_io_events WHERE session_id=? AND event_id=?').get(sessionId, event.event_id);
        if (existing) { if (JSON.stringify(parse(existing)) !== JSON.stringify(event)) throw new ConflictError('Runtime history rewrote an existing event'); continue; }
        this.db.prepare('INSERT INTO runtime_io_events VALUES(?,?,?,?)').run(sessionId, event.event_id, event.sequence, JSON.stringify(event));
      }
      this.db.prepare('INSERT INTO runtime_io_cursors VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor').run(sessionId, page.cursor);
    });
  }
  events(sessionId: string): IoEvent[] { return this.db.prepare('SELECT value_json FROM runtime_io_events WHERE session_id=? ORDER BY sequence,event_id').all(sessionId).map(row => parse<IoEvent>(row)!); }
  setView(kind: string, id: string, value: unknown) {
    if (['objective', 'approval', 'thread'].includes(kind)) {
      const previous = parse<{ revision?: number }>(this.db.prepare('SELECT value_json FROM runtime_views WHERE kind=? AND id=?').get(kind, id));
      const revision = (value as { revision?: number })?.revision;
      if (Number.isSafeInteger(previous?.revision) && Number.isSafeInteger(revision) && previous!.revision! > revision!) return;
    }
    this.db.prepare('INSERT INTO runtime_views VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value_json=excluded.value_json').run(kind, id, JSON.stringify(value));
  }
  views<T>(kind: string): T[] { return this.db.prepare('SELECT value_json FROM runtime_views WHERE kind=? ORDER BY id').all(kind).map(row => parse<T>(row)!); }
  replaceApprovals(approvals: RuntimeApproval[]) {
    this.transaction(() => {
      const previous = new Map(this.views<RuntimeApproval>('approval').map(value => [value.id, value]));
      this.db.prepare("DELETE FROM runtime_views WHERE kind='approval'").run();
      for (const value of approvals) {
        const known = previous.get(value.id);
        if (known && known.revision > value.revision) { if (known.status === 'pending_human') this.setView('approval', known.id, known); }
        else this.setView('approval', value.id, value);
      }
    });
  }
  objectives(): RuntimeObjective[] { return this.views<RuntimeObjective>('objective'); }
  messagesPage(input: {before?:string;limit?:number} = {}) {
    if (!input || Object.keys(input).some(k=>!['before','limit'].includes(k))) throw new ConflictError('Invalid history page');
    const limit = input.limit ?? 100, binding = this.binding();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ConflictError('History page limit must be between 1 and 100');
    let before: number|null = null;
    if (input.before !== undefined) {
      try {
        if (typeof input.before !== 'string' || input.before.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.before)) throw new Error();
        const cursor = JSON.parse(Buffer.from(input.before,'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== 1 || !binding || cursor[1] !== binding.sessionId || !Number.isSafeInteger(cursor[2]) || cursor[2] < 0 || typeof cursor[3] !== 'string') throw new Error();
        const event = this.db.prepare("SELECT sequence FROM runtime_io_events WHERE session_id=? AND event_id=? AND json_extract(value_json,'$.type') IN ('input.accepted','output.committed')").get(binding.sessionId,cursor[3]) as {sequence:number}|undefined;
        if (!event || event.sequence !== cursor[2]) throw new Error();
        before = cursor[2];
      } catch { throw new ConflictError('History cursor is invalid or belongs to another Session'); }
    }
    const events = binding ? this.db.prepare("SELECT value_json FROM runtime_io_events WHERE session_id=? AND (? IS NULL OR sequence<?) AND json_extract(value_json,'$.type') IN ('input.accepted','output.committed') ORDER BY sequence DESC,event_id DESC LIMIT ?").all(binding.sessionId,before,before,limit+1).map(row=>parse<IoEvent>(row)!) : [];
    const hasOlder = events.length > limit;
    const selected = events.slice(0,limit).reverse();
    const messages = selected.map(event => {
      const content = event.message?.content, value = content?.value as {text?:unknown}|undefined;
      const text = content?.encoding === 'json' && typeof value?.text === 'string' ? value.text : content?.encoding === 'utf8' && typeof content.text === 'string' ? content.text : '[Unsupported message format]';
      return {id:event.event_id,role:event.type==='input.accepted'?'user':'assistant',text,created_at:event.timestamp?Date.parse(event.timestamp):0,sequence:event.sequence,thread_id:event.thread_id,root_turn_id:event.root_turn_id,resources:event.resources??[]};
    });
    const first = selected[0];
    return {messages,messageHistory:{sessionId:binding?.sessionId??null,limit,hasOlder,nextBefore:hasOlder&&first?Buffer.from(JSON.stringify([1,binding!.sessionId,first.sequence,first.event_id])).toString('base64url'):null}};
  }
  snapshot() {
    const binding = this.binding();
    const page = this.messagesPage();
    const recent = this.db.prepare("SELECT * FROM runtime_commands WHERE status IN ('accepted','rejected') ORDER BY created_at DESC,id DESC LIMIT 100").all().map(row => this.decode(row)!);
    const commands = [...recent, ...this.unresolvedCommands()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
    return {
      binding: binding ? { userId: binding.userId, agentId: binding.agentId, contextId: binding.contextId, sessionId: binding.sessionId, principalId: binding.principalId, verified: binding.verified } : null,
      sessionId: binding?.sessionId ?? null, ...page,
      jobs: this.objectives().map(value => ({ ...value, prompt: value.stated_objective, source: 'runtime' })),
      approvals: this.views<RuntimeApproval>('approval'), threads: this.views<Record<string, unknown>>('thread'),
      commands: commands.map(value => this.publicCommand(value)),
      audit: this.db.prepare('SELECT id,event,command_id,created_at FROM runtime_audit ORDER BY id DESC LIMIT 100').all().reverse(),
    };
  }
  close() { this.db.close(); }
}
