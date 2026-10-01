import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { IoEvent, RuntimeApproval, RuntimeObjective } from './morphz-adapter.ts';

export class NotificationError extends Error {}
export interface NotificationBinding { userId: string; sessionId: string; contextId: string; agentId: string }
export interface NotificationSync {
  sessionId: string;
  events?: IoEvent[];
  /** Only a successful authorized Session read can certify a complete inventory. */
  approvals?: { items: RuntimeApproval[]; complete: boolean };
  objectives?: RuntimeObjective[];
}
type Kind = 'reply' | 'approval' | 'objective';
type Mode = 'all' | 'off';
interface Head { kind: Kind; source_id: string; revision: number; signature: string; notification_id: string | null }
export interface NotificationItem {
  id: string; kind: Kind; title: string; reason: string;
  sourceId: string; sourceRevision: number; sourceStatus: string; sourceAt: string | null;
  createdAt: number; read: boolean; readAt: number | null;
  target: 'conversation' | 'approvals' | 'tasks';
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const sourceTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const approvalStatuses = new Set(['pending_auto', 'pending_human', 'allowed', 'denied', 'cancelled']);
const objectiveStatuses = new Set(['active', 'paused', 'blocked', 'completed', 'cancelled', 'failed']);

/** Durable, single-user in-app delivery only. There is no browser permission,
 * external recipient, push transport, or claim that a human saw a stored item.
 * Source facts are replayable; their queue publication is one SQLite transaction.
 * Persisted source identities/read receipts are never evicted, so old history
 * cannot resurrect a notice after restart. Message/approval bodies are not copied.
 */
export class NotificationOutbox {
  private db: DatabaseSync;
  private binding: NotificationBinding;
  private now: () => number;
  constructor(path: string, binding: NotificationBinding, now = Date.now) {
    if (!binding || ![binding.userId, binding.sessionId, binding.contextId, binding.agentId].every(identity)) throw new NotificationError('A fixed notification identity is required');
    this.binding = { userId: binding.userId, sessionId: binding.sessionId, contextId: binding.contextId, agentId: binding.agentId }; this.now = now;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS notification_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding_json TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('all','off')));
        CREATE TABLE IF NOT EXISTS notification_heads(kind TEXT NOT NULL,source_id TEXT NOT NULL,revision INTEGER NOT NULL,signature TEXT NOT NULL,notification_id TEXT,PRIMARY KEY(kind,source_id));
        CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_status TEXT NOT NULL,source_at TEXT,created_at INTEGER NOT NULL,read_at INTEGER,state TEXT NOT NULL CHECK(state IN ('available','suppressed','superseded')));
        CREATE INDEX IF NOT EXISTS notification_available ON notification_outbox(state,created_at,id);`);
      this.transaction(() => {
        const row = this.db.prepare('SELECT binding_json FROM notification_binding WHERE singleton=1').get() as { binding_json: string } | undefined;
        const encoded = JSON.stringify(this.binding);
        if (row && row.binding_json !== encoded) throw new NotificationError('Notification database belongs to another user or Session');
        if (!row) this.db.prepare("INSERT INTO notification_binding VALUES(1,?,'all')").run(encoded);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private mode(): Mode { return (this.db.prepare('SELECT mode FROM notification_binding WHERE singleton=1').get() as { mode: Mode }).mode; }
  private head(kind: Kind, id: string): Head | undefined { return this.db.prepare('SELECT * FROM notification_heads WHERE kind=? AND source_id=?').get(kind, id) as Head | undefined; }
  private supersede(id: string | null) { if (id) this.db.prepare("UPDATE notification_outbox SET state='superseded' WHERE id=?").run(id); }
  private writeHead(kind: Kind, id: string, rev: number, signature: string, notice: string | null) {
    this.db.prepare('INSERT INTO notification_heads VALUES(?,?,?,?,?) ON CONFLICT(kind,source_id) DO UPDATE SET revision=excluded.revision,signature=excluded.signature,notification_id=excluded.notification_id').run(kind, id, rev, signature, notice);
  }
  private publish(kind: Kind, id: string, rev: number, status: string, at: unknown): string {
    const key = digest([this.binding.userId, this.binding.sessionId, kind, id, rev, status]);
    this.db.prepare('INSERT INTO notification_outbox VALUES(?,?,?,?,?,?,?,NULL,?)').run(key, kind, id, rev, status, sourceTime(at), this.now(), this.mode() === 'all' ? 'available' : 'suppressed');
    return key;
  }
  sync(input: NotificationSync) {
    if (!input || input.sessionId !== this.binding.sessionId) throw new NotificationError('Notification source is outside the fixed Session');
    this.transaction(() => {
      for (const event of input.events ?? []) {
        if (event.session_id !== undefined && event.session_id !== this.binding.sessionId) throw new NotificationError('Notification event is outside the fixed Session');
        if (event.type !== 'output.committed') continue;
        if (!identity(event.event_id) || !revision(event.sequence)) throw new NotificationError('Invalid committed output identity');
        // The fingerprint catches an immutable output being rewritten without storing its body.
        const signature = digest([event.sequence, event.timestamp ?? null, event.message ?? null]);
        const prior = this.head('reply', event.event_id);
        if (prior) { if (prior.signature !== signature) throw new NotificationError('Immutable notification output changed'); continue; }
        this.writeHead('reply', event.event_id, event.sequence, signature, this.publish('reply', event.event_id, event.sequence, 'committed', event.timestamp));
      }
      if (input.approvals) {
        if (!Array.isArray(input.approvals.items) || typeof input.approvals.complete !== 'boolean') throw new NotificationError('Approval inventory completeness is required');
        const seen = new Set<string>();
        for (const approval of input.approvals.items) {
          if (!identity(approval.id) || !revision(approval.revision) || !approvalStatuses.has(approval.status)) throw new NotificationError('Invalid approval notification source');
          if (approval.session_id !== undefined && approval.session_id !== this.binding.sessionId) throw new NotificationError('Approval is outside the fixed Session');
          if (approval.context_id !== undefined && approval.context_id !== this.binding.contextId) throw new NotificationError('Approval is outside the fixed Context');
          seen.add(approval.id);
          this.mutable('approval', approval.id, approval.revision, approval.status, approval.status === 'pending_human', approval.updated_at);
        }
        // A truncated response or failed read must never dismiss pending approvals.
        if (input.approvals.complete) for (const row of this.db.prepare("SELECT * FROM notification_heads WHERE kind='approval'").all() as unknown as Head[]) {
          if (!seen.has(row.source_id)) this.supersede(row.notification_id);
        }
      }
      for (const objective of input.objectives ?? []) {
        if (objective.context_id !== this.binding.contextId || objective.agent_id !== this.binding.agentId) throw new NotificationError('Objective is outside the fixed Context or Agent');
        if (objective.delivery_session_id !== this.binding.sessionId) continue;
        // 'unknown' is the host's bounded-inventory uncertainty marker, not a Runtime transition.
        if (objective.status === 'unknown') continue;
        if (!identity(objective.id) || !revision(objective.revision) || !objectiveStatuses.has(objective.status)) throw new NotificationError('Invalid objective notification source');
        this.mutable('objective', objective.id, objective.revision, objective.status, terminal.has(objective.status), objective.updated_at);
      }
    });
    return this.snapshot();
  }
  private mutable(kind: 'approval' | 'objective', id: string, rev: number, status: string, actionable: boolean, at: unknown) {
    const prior = this.head(kind, id);
    if (prior && rev < prior.revision) return;
    if (prior && rev === prior.revision) {
      if (prior.signature !== status) throw new NotificationError('Notification source revision changed its status');
      return;
    }
    // A terminal Objective's housekeeping-only revision must not remind again.
    if (kind === 'objective' && prior?.signature === status) { this.writeHead(kind, id, rev, status, prior.notification_id); return; }
    this.supersede(prior?.notification_id ?? null);
    this.writeHead(kind, id, rev, status, actionable ? this.publish(kind, id, rev, status, at) : null);
  }
  snapshot(limit = 100, after?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new NotificationError('Notification page limit must be from 1 through 200');
    const mode = this.mode();
    const counts = this.db.prepare("SELECT COUNT(*) AS total,COUNT(CASE WHEN read_at IS NULL THEN 1 END) AS unread FROM notification_outbox WHERE state='available'").get() as { total: number; unread: number };
    let cursor: [number, string] | undefined;
    if (after !== undefined) {
      try {
        if (typeof after !== 'string' || after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(after)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== digest(this.binding) || !revision(value[2]) || typeof value[3] !== 'string' || !/^[a-f0-9]{64}$/.test(value[3])) throw new Error();
        cursor = [value[2], value[3]];
      } catch { throw new NotificationError('Invalid notification page cursor for this Session'); }
    }
    const rows = cursor
      ? this.db.prepare("SELECT * FROM notification_outbox WHERE state='available' AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(cursor[0], cursor[0], cursor[1], limit + 1)
      : this.db.prepare("SELECT * FROM notification_outbox WHERE state='available' ORDER BY created_at DESC,id DESC LIMIT ?").all(limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const items: NotificationItem[] = rows.map((row: any) => {
      const title = row.kind === 'reply' ? '助手有新回复' : row.kind === 'approval' ? '有操作等待你审批' : row.source_status === 'completed' ? '事项已完成' : row.source_status === 'failed' ? '事项执行失败' : '事项已取消';
      return { id: row.id, kind: row.kind, title, reason: row.kind === 'reply' ? 'Runtime 已保存一条回复' : row.kind === 'approval' ? 'Runtime 请求人工审批，尚未获得授权' : 'Runtime 已确认事项的终止状态', sourceId: row.source_id, sourceRevision: row.source_revision, sourceStatus: row.source_status, sourceAt: row.source_at, createdAt: row.created_at, read: row.read_at !== null, readAt: row.read_at, target: row.kind === 'reply' ? 'conversation' : row.kind === 'approval' ? 'approvals' : 'tasks' };
    });
    const last = items.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([1, digest(this.binding), last.createdAt, last.id])).toString('base64url') : null;
    return { channel: 'in_app' as const, delivery: 'local_inbox_only' as const, mode, items, unread: mode === 'off' ? 0 : counts.unread, total: counts.total, truncated: hasMore, nextCursor };
  }
  acknowledge(ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new NotificationError('Use at most 200 exact notification identities');
    this.transaction(() => {
      for (const id of new Set(ids)) {
        const row = this.db.prepare("SELECT id FROM notification_outbox WHERE id=? AND state='available'").get(id);
        if (!row) throw new NotificationError('Notification is no longer available in this Session');
        this.db.prepare('UPDATE notification_outbox SET read_at=COALESCE(read_at,?) WHERE id=?').run(this.now(), id);
      }
    });
    return this.snapshot();
  }
  setMode(mode: Mode) {
    if (!['all', 'off'].includes(mode)) throw new NotificationError('Notification mode supports all or off');
    this.transaction(() => {
      this.db.prepare('UPDATE notification_binding SET mode=? WHERE singleton=1').run(mode);
      if (mode === 'off') this.db.prepare("UPDATE notification_outbox SET state='suppressed' WHERE state='available' AND read_at IS NULL").run();
    });
    return this.snapshot();
  }
  close() { this.db.close(); }
}
