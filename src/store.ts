import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IoEventPage } from './morphz-adapter.ts';

export class ConflictError extends Error {}
export class MissingError extends Error {}

export interface DeliveryJob {
  id: string;
  idempotency_key: string;
  prompt: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed';
  approval_status: 'not_required' | 'pending' | 'approved' | 'denied';
  attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
}

/** Durable product projections/delivery bookkeeping only. No agent reasoning state. */
export class ProductStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS delivery_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','completed','cancelled','failed')),
        approval_status TEXT NOT NULL CHECK(approval_status IN ('not_required','pending','approved','denied')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_claimable ON delivery_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        exchange_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(exchange_key, role)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        event TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_inbox (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, event_id),
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS event_cursors (
        session_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL
      );
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private audit(jobId: string | null, event: string, detail: object, now: number) {
    this.db.prepare('INSERT INTO audit_log(job_id,event,detail_json,created_at) VALUES(?,?,?,?)')
      .run(jobId, event, JSON.stringify(detail), now);
  }

  enqueue(prompt: string, key: string, requireApproval = false, now = Date.now()): DeliveryJob {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM delivery_jobs WHERE idempotency_key=?').get(key) as unknown as DeliveryJob | undefined;
      if (existing) {
        const originallyRequired = existing.approval_status !== 'not_required';
        if (existing.prompt !== prompt || originallyRequired !== requireApproval) throw new ConflictError('Idempotency key is already used for another request');
        return existing;
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO delivery_jobs(id,idempotency_key,prompt,status,approval_status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, key, prompt, requireApproval ? 'awaiting_approval' : 'queued', requireApproval ? 'pending' : 'not_required', now, now);
      this.audit(id, 'job.enqueued', { mode: 'demo', requires_approval: requireApproval }, now);
      return this.getJob(id)!;
    });
  }

  getJob(id: string): DeliveryJob | undefined {
    return this.db.prepare('SELECT * FROM delivery_jobs WHERE id=?').get(id) as unknown as DeliveryJob | undefined;
  }

  decide(id: string, decision: 'approve' | 'deny', now = Date.now()): DeliveryJob {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) throw new MissingError('Job not found');
      const desired = decision === 'approve' ? 'approved' : 'denied';
      if (job.approval_status === desired) return job; // Safe repeat of the same decision.
      if (job.status !== 'awaiting_approval' || job.approval_status !== 'pending') throw new ConflictError('This job is no longer awaiting approval');
      this.db.prepare('UPDATE delivery_jobs SET status=?,approval_status=?,updated_at=? WHERE id=?')
        .run(decision === 'approve' ? 'queued' : 'cancelled', desired, now, id);
      this.audit(id, `approval.${desired}`, { actor: 'local-user', scope: 'one-demo-delivery' }, now);
      return this.getJob(id)!;
    });
  }

  /** Atomically recover expired leases and claim one authorized delivery. */
  claim(now = Date.now(), leaseMs = 15_000): DeliveryJob | undefined {
    return this.transaction(() => {
      const expired = this.db.prepare("SELECT id FROM delivery_jobs WHERE status='running' AND lease_until<=?").all(now) as unknown as { id: string }[];
      for (const { id } of expired) {
        this.db.prepare("UPDATE delivery_jobs SET status='queued',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(now, id);
        this.audit(id, 'lease.recovered', {}, now);
      }
      const next = this.db.prepare("SELECT * FROM delivery_jobs WHERE status='queued' AND approval_status IN ('not_required','approved') ORDER BY created_at,id LIMIT 1").get() as unknown as DeliveryJob | undefined;
      if (!next) return undefined;
      this.db.prepare("UPDATE delivery_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?")
        .run(randomUUID(), now + leaseMs, now, next.id);
      this.audit(next.id, 'delivery.started', { attempt: next.attempts + 1, mode: 'demo' }, now);
      return this.getJob(next.id)!;
    });
  }

  renew(id: string, token: string, now = Date.now(), leaseMs = 15_000): boolean {
    return this.db.prepare("UPDATE delivery_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
      .run(now + leaseMs, now, id, token, now).changes === 1;
  }

  complete(id: string, token: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const updated = this.db.prepare("UPDATE delivery_jobs SET status='completed',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
        .run(now, id, token, now).changes;
      if (!updated) return false;
      const job = this.getJob(id)!;
      this.db.prepare('INSERT OR IGNORE INTO chat_messages(id,exchange_key,role,text,created_at) VALUES(?,?,?,?,?)')
        .run(randomUUID(), `job:${id}`, 'system', `Simulated background delivery finished: ${job.prompt}\nThis is a local demonstration. No model or Morphz runtime executed this task.`, now);
      this.audit(id, 'delivery.simulated_complete', { mode: 'demo' }, now);
      return true;
    });
  }

  addDemoChat(text: string, key: string, now = Date.now()) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM chat_messages WHERE exchange_key=? AND role='user'").get(`chat:${key}`) as { text: string } | undefined;
      if (existing) {
        if (existing.text !== text) throw new ConflictError('Idempotency key is already used for another message');
        return { duplicate: true };
      }
      const insert = this.db.prepare('INSERT INTO chat_messages(id,exchange_key,role,text,created_at) VALUES(?,?,?,?,?)');
      insert.run(randomUUID(), `chat:${key}`, 'user', text, now);
      insert.run(randomUUID(), `chat:${key}`, 'assistant', 'Message received in the local demo. I can keep this chat responsive while the separate worker simulates background deliveries. No AI response was generated.', now + 1);
      this.audit(null, 'chat.demo_acknowledged', { mode: 'demo' }, now);
      return { duplicate: false };
    });
  }

  /** Atomically persist typed IO events and the returned opaque page cursor.
   * Physical sequence numbers can have gaps because Morphz filters history.
   * Empty pages can advance the cursor. Message admission receipts never do.
   */
  ingestEventPage(sessionId: string, after: string | null, page: IoEventPage, now = Date.now()): number {
    return this.transaction(() => {
      if (!page.cursor || typeof page.cursor !== 'string') throw new Error('Missing page cursor');
      const current = this.eventCursor(sessionId);
      const replay = current === page.cursor;
      if (after !== current && !replay) throw new ConflictError('Event cursor changed; fetch a fresh page');
      let added = 0;
      let previous = 0;
      for (const event of page.events) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !event.event_id || event.io_version !== '1') throw new Error('Invalid event identity or sequence');
        if (event.sequence <= previous) throw new ConflictError('Event page must be ordered');
        previous = event.sequence;
        const existing = this.db.prepare('SELECT sequence,topic,payload_json FROM event_inbox WHERE session_id=? AND event_id=?').get(sessionId, event.event_id) as { sequence: number; topic: string; payload_json: string } | undefined;
        if (existing) {
          if (existing.sequence !== event.sequence || existing.topic !== event.type || existing.payload_json !== JSON.stringify(event)) throw new ConflictError('Event identity reused with different contents');
          continue;
        }
        if (after !== current) throw new ConflictError('Replay contains an unknown event');
        this.db.prepare('INSERT INTO event_inbox(session_id,event_id,sequence,topic,payload_json,received_at) VALUES(?,?,?,?,?,?)')
          .run(sessionId, event.event_id, event.sequence, event.type, JSON.stringify(event), now);
        added += 1;
      }
      this.db.prepare('INSERT INTO event_cursors(session_id,cursor) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor')
        .run(sessionId, page.cursor);
      return added;
    });
  }

  eventCursor(sessionId: string): string | null {
    return (this.db.prepare('SELECT cursor FROM event_cursors WHERE session_id=?').get(sessionId) as { cursor: string } | undefined)?.cursor ?? null;
  }

  snapshot() {
    return {
      messages: this.db.prepare('SELECT id,role,text,created_at FROM (SELECT rowid,id,role,text,created_at FROM chat_messages ORDER BY rowid DESC LIMIT 100) ORDER BY rowid').all(),
      jobs: this.db.prepare('SELECT id,prompt,status,approval_status,attempts,created_at,updated_at FROM delivery_jobs ORDER BY created_at DESC,id LIMIT 100').all(),
      audit: this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all(),
    };
  }

  close() { this.db.close(); }
}
