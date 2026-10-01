import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { COMPUTER_TOOL, ComputerEdgeError, edgeId, parseComputerRequest, validateComputerBinding, validateComputerCommand, type ComputerAction, type ComputerDisplay, type ComputerEdgeArbiter, type ComputerEdgeBinding, type ComputerEdgeCommand, type ComputerEdgeDriver, type ComputerEdgeFinish, type ComputerEdgeLease, type ComputerEdgeTransport, type ComputerExecutionScope, type ComputerToolRequest } from './computer-edge-types.ts';

const SAFE_CODES = new Set(['invalid_computer_request', 'invalid_computer_display', 'invalid_computer_capture', 'computer_job_cancelled', 'computer_receipt_not_found', 'computer_operation_revoked', 'computer_lease_revoked', 'computer_display_changed', 'computer_observation_stale', 'computer_coordinates_out_of_bounds', 'computer_effect_approval_required', 'computer_authorization_expired', 'computer_result_retention_full', 'computer_command_scope_mismatch', 'edge_heartbeat_identity_mismatch', 'edge_request_aborted', 'edge_transport_unconfirmed', 'edge_http_401', 'edge_http_403', 'edge_http_409', 'edge_http_503']);
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export const COMPUTER_EDGE_LIMITS = { screenshotBytes: 1024 * 1024, observationMs: 60_000, resultRetentionMs: 10 * 60_000, retainedResults: 32, driverDeadlineMs: 10_000, authorizationMs: 45_000 } as const;
interface Journal { job_id: string; fingerprint: string; thread_id: string; state: 'running' | 'complete' | 'unknown'; summary: string; finish_json: string | null; lease_json: string | null; delivered: number; expires_at: number }
interface Observation { id: string; thread_id: string; epoch: number; display_id: string; width: number; height: number; expires_at: number; used_by: string | null }
export interface ComputerActionPermit {
  approved: true; receiptId: string; jobId: string; threadId: string; epoch: number;
  observationId: string; actionDigest: string; expiresAt: number;
}
export const computerActionDigest = (action: ComputerAction) => hash(JSON.stringify(action));
export interface ComputerEdgeExecutorOptions {
  db: DatabaseSync | string; binding: ComputerEdgeBinding; workerId: string;
  transport: ComputerEdgeTransport; arbiter: ComputerEdgeArbiter; driver: ComputerEdgeDriver;
  /** Revalidate the fixed current principal/session and requested operation. No
   * authority is inferred from model text, host context_ids or a stale UI selection. */
  authorize: (scope: ComputerExecutionScope, request: ComputerToolRequest, identity: { jobId: string; actionDigest?: string; signal: AbortSignal; expiresAt: number }) => Promise<void | ComputerActionPermit>;
  now?: () => number;
  /** May only shorten the production deadline/heartbeat interval, useful for fixtures. */
  authorizationTimeoutMs?: number; heartbeatIntervalMs?: number;
}
function leaseOf(command: ComputerEdgeCommand): ComputerEdgeLease {
  return { job_id: command.job_id, revision: command.revision, target_id: command.target_id, provider_node_id: command.provider_node_id, tool_name: command.tool_name, argumentsHash: hash(command.arguments), route: command.route, status: command.status, claimed_by: command.claimed_by, claim_token: command.claim_token, lease_expires_at: command.lease_expires_at, side_effect_started_at: command.side_effect_started_at };
}
function failure(code: string): ComputerEdgeFinish { return { status: 'failed', output: null, error: code }; }
/** One worker and one physical arbiter per desktop. No timers, credential creation,
 * native pairing, desktop input or connections on construction. runOnce is explicit.
 * Driver calls never repeat for an existing job, including crash/unknown outcomes.
 */
export class ComputerEdgeExecutor {
  private db: DatabaseSync;
  private ownDb: boolean;
  private options: ComputerEdgeExecutorOptions;
  private scope: string;
  private now: () => number;
  private busy = false;
  private closed = false;
  private lifetime = new AbortController();
  private active?: Promise<unknown>;
  private recoveryNeedsPause = false;
  constructor(options: ComputerEdgeExecutorOptions) {
    validateComputerBinding(options.binding);
    if (!edgeId(options.workerId)) throw new ComputerEdgeError('invalid_worker_id', 400);
    this.options = options; this.now = options.now ?? Date.now; this.ownDb = typeof options.db === 'string'; this.db = this.ownDb ? new DatabaseSync(options.db as string) : options.db as DatabaseSync;
    this.scope = hash(JSON.stringify([options.binding.nodeId, options.binding.targetId, options.binding.principalId, options.binding.agentId, options.binding.contextId, options.binding.sessionId, options.binding.policyDigest]));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS computer_edge_journal(scope TEXT NOT NULL,job_id TEXT NOT NULL,fingerprint TEXT NOT NULL,thread_id TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,finish_json TEXT,lease_json TEXT,delivered INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,job_id));
      CREATE TABLE IF NOT EXISTS computer_edge_observations(scope TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,epoch INTEGER NOT NULL,display_id TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT,PRIMARY KEY(scope,id));`);
    // A process loss during any driver interaction is unconfirmed. Preserve the
    // native job identity and never reconstruct input or repeat the driver call.
    this.recoveryNeedsPause = Number((this.db.prepare("SELECT COUNT(*) n FROM computer_edge_journal WHERE scope=? AND state='running'").get(this.scope) as { n: number }).n) > 0;
    this.db.prepare("UPDATE computer_edge_journal SET state='unknown',summary=?,finish_json=? WHERE scope=? AND state='running'")
      .run(JSON.stringify({ status: 'unknown', code: 'computer_process_interrupted' }), JSON.stringify(failure('computer_process_interrupted')), this.scope);
    this.db.prepare('UPDATE computer_edge_observations SET expires_at=0 WHERE scope=?').run(this.scope);
    this.purge();
  }
  private open() { if (this.closed) throw new ComputerEdgeError('computer_executor_closed', 503); }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private purge() {
    // Once an observation was consumed and its native result was acknowledged,
    // its image is no longer needed for review or transport retry.
    this.db.prepare(`UPDATE computer_edge_journal SET finish_json=NULL,lease_json=NULL
      WHERE scope=? AND delivered=1 AND json_extract(summary,'$.observationId') IN
      (SELECT id FROM computer_edge_observations WHERE scope=? AND used_by IS NOT NULL)`).run(this.scope, this.scope);
    this.db.prepare('UPDATE computer_edge_journal SET finish_json=NULL,lease_json=NULL WHERE scope=? AND expires_at<=?').run(this.scope, this.now());
    this.db.prepare('DELETE FROM computer_edge_observations WHERE scope=? AND expires_at<=?').run(this.scope, this.now());
  }
  private row(jobId: string) { return this.db.prepare('SELECT * FROM computer_edge_journal WHERE scope=? AND job_id=?').get(this.scope, jobId) as unknown as Journal | undefined; }
  private assertLease(epoch: number, display?: ComputerDisplay, signal?: AbortSignal) {
    if (this.closed || signal?.aborted) throw new ComputerEdgeError('computer_operation_revoked');
    const state = this.options.arbiter.state();
    if (state.owner !== 'ai' || state.epoch !== epoch || state.leaseUntil <= this.now()) throw new ComputerEdgeError('computer_lease_revoked');
    if (display) { const current = this.options.driver.display(); if (current.id !== display.id || current.width !== display.width || current.height !== display.height) throw new ComputerEdgeError('computer_display_changed'); }
  }
  private display() {
    const d = this.options.driver.display();
    if (!edgeId(d.id) || ![d.width, d.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16_384)) throw new ComputerEdgeError('invalid_computer_display', 503);
    return d;
  }
  /** Trusted host tick only. A successful native heartbeat is necessary before
   * renewing the same already-held AI epoch. A failure pauses; no auto-resume. */
  async maintainLease(epoch: number) {
    this.open(); this.assertLease(epoch);
    try { await this.options.transport.heartbeatNode(this.lifetime.signal); this.assertLease(epoch); await this.options.arbiter.renewAi(epoch); }
    catch { await this.options.arbiter.pause(false, epoch); throw new ComputerEdgeError('computer_connection_unhealthy', 503); }
  }
  async runOnce(): Promise<{ jobId: string; state: string; delivered: boolean } | null> {
    this.open(); if (this.busy) throw new ComputerEdgeError('computer_worker_busy');
    this.busy = true;
    const work = this.run(); this.active = work;
    try { return await work; } finally { this.busy = false; this.active = undefined; }
  }
  private async run() {
    this.purge();
    if (this.recoveryNeedsPause) { await this.options.arbiter.pause(true); this.recoveryNeedsPause = false; }
    const connectionEpoch = this.options.arbiter.state().epoch;
    try { await this.options.transport.heartbeatNode(this.lifetime.signal); }
    catch { await this.options.arbiter.pause(false, connectionEpoch); throw new ComputerEdgeError('computer_connection_unhealthy', 503); }
    const pendingResults = (this.db.prepare('SELECT COUNT(*) n FROM computer_edge_journal WHERE scope=? AND delivered=0 AND finish_json IS NOT NULL').get(this.scope) as { n: number }).n;
    if (pendingResults >= COMPUTER_EDGE_LIMITS.retainedResults) throw new ComputerEdgeError('computer_result_retention_full', 429);
    let command: ComputerEdgeCommand | null;
    try { command = await this.options.transport.claim(this.lifetime.signal); }
    catch { await this.options.arbiter.pause(false, connectionEpoch); throw new ComputerEdgeError('computer_claim_unconfirmed', 503); }
    if (!command) return null;
    command = validateComputerCommand(command, this.options.binding, this.options.workerId);
    if (Date.parse(command.lease_expires_at) <= this.now()) throw new ComputerEdgeError('computer_claim_expired');
    const fingerprint = hash(JSON.stringify({ arguments: command.arguments, route: command.route, tool: command.tool_name }));
    const old = this.row(command.job_id);
    if (old) {
      if (old.fingerprint !== fingerprint) { await this.options.arbiter.pause(false, connectionEpoch); throw new ComputerEdgeError('computer_job_content_conflict'); }
      if (!old.delivered && old.finish_json && old.lease_json) {
        this.db.prepare('UPDATE computer_edge_journal SET lease_json=? WHERE scope=? AND job_id=?').run(JSON.stringify(leaseOf(command)), this.scope, command.job_id);
        await this.deliver(command.job_id);
      }
      return this.result(command.job_id);
    }
    const retained = (this.db.prepare("SELECT COUNT(*) n FROM computer_edge_journal WHERE scope=? AND finish_json IS NOT NULL AND (delivered=0 OR json_extract(summary,'$.status')='observed')").get(this.scope) as { n: number }).n;
    this.db.prepare('INSERT INTO computer_edge_journal(scope,job_id,fingerprint,thread_id,state,summary,lease_json,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.scope, command.job_id, fingerprint, command.route.execution_scope.thread_id, 'running', JSON.stringify({ status: 'pending' }), JSON.stringify(leaseOf(command)), this.now() + COMPUTER_EDGE_LIMITS.resultRetentionMs);
    let driverEntered = false;
    let request: ComputerToolRequest | undefined;
    const operationAbort = new AbortController();
    const operationSignal = AbortSignal.any([this.lifetime.signal, operationAbort.signal]);
    let sideEffectStarted = false;
    let heartbeatQueue: Promise<void> = Promise.resolve();
    const heartbeat = (startEffect = false) => {
      if (startEffect) sideEffectStarted = true;
      const task = heartbeatQueue.then(async () => {
        if (operationSignal.aborted) throw new ComputerEdgeError('computer_operation_revoked');
        const before = command!;
        const updated = await this.options.transport.heartbeat(before, sideEffectStarted, operationSignal);
        validateComputerCommand(updated, this.options.binding, this.options.workerId);
        if (updated.job_id !== before.job_id || updated.claim_token !== before.claim_token || updated.arguments !== before.arguments || JSON.stringify(updated.route) !== JSON.stringify(before.route) || updated.revision < before.revision) throw new ComputerEdgeError('edge_heartbeat_identity_mismatch', 403);
        command = updated;
        this.db.prepare('UPDATE computer_edge_journal SET lease_json=? WHERE scope=? AND job_id=?').run(JSON.stringify(leaseOf(updated)), this.scope, updated.job_id);
        if (updated.status !== 'claimed' || Date.parse(updated.lease_expires_at) <= this.now()) throw new ComputerEdgeError('computer_job_cancelled');
        if (request && 'epoch' in request) { this.assertLease(request.epoch); await this.options.arbiter.renewAi(request.epoch); }
      }).catch(error => { operationAbort.abort(); throw error; });
      heartbeatQueue = task.catch(() => {});
      return task;
    };
    const heartbeatTimer = setInterval(() => { void heartbeat().catch(async () => { await this.options.arbiter.pause(false, request && 'epoch' in request ? request.epoch : connectionEpoch); }).catch(() => {}); }, Math.max(50, Math.min(5000, this.options.heartbeatIntervalMs ?? 5000)));
    try {
      if (command.status !== 'claimed') throw new ComputerEdgeError('computer_job_cancelled');
      request = parseComputerRequest(command.arguments);
      if (request.action === 'observe' && retained >= COMPUTER_EDGE_LIMITS.retainedResults) throw new ComputerEdgeError('computer_result_retention_full', 429);
      if ('epoch' in request) this.assertLease(request.epoch, this.display());
      if (request.action === 'act') this.inspectObservation(request.observationId, command.route.execution_scope.thread_id, request.epoch, this.display());
      const approvalTimeout = Math.max(1, Math.min(COMPUTER_EDGE_LIMITS.authorizationMs, this.options.authorizationTimeoutMs ?? COMPUTER_EDGE_LIMITS.authorizationMs));
      const approvalAbort = new AbortController();
      const approvalSignal = AbortSignal.any([operationSignal, approvalAbort.signal]);
      const approvalTimer = setTimeout(() => approvalAbort.abort(), approvalTimeout);
      let permit: void | ComputerActionPermit;
      let onAbort!: () => void;
      try {
        if (approvalSignal.aborted) throw new ComputerEdgeError('computer_operation_revoked');
        permit = await Promise.race([
          this.options.authorize(command.route.execution_scope, request, { jobId: command.job_id, ...(request.action === 'act' ? { actionDigest: computerActionDigest(request.operation) } : {}), signal: approvalSignal, expiresAt: this.now() + approvalTimeout }),
          new Promise<never>((_, reject) => { onAbort = () => reject(new ComputerEdgeError('computer_authorization_expired')); approvalSignal.addEventListener('abort', onAbort, { once: true }); }),
        ]);
      } finally { clearTimeout(approvalTimer); approvalSignal.removeEventListener('abort', onAbort); }
      if (operationSignal.aborted) throw new ComputerEdgeError('computer_operation_revoked');
      const assertPermit = () => {
        if (request?.action !== 'act') return;
        if (!permit || permit.approved !== true || !edgeId(permit.receiptId) || permit.jobId !== command!.job_id || permit.threadId !== command!.route.execution_scope.thread_id || permit.epoch !== request.epoch || permit.observationId !== request.observationId || permit.actionDigest !== computerActionDigest(request.operation) || !Number.isFinite(permit.expiresAt) || permit.expiresAt <= this.now() || permit.expiresAt > this.now() + 300_000) throw new ComputerEdgeError('computer_effect_approval_required', 403);
      };
      assertPermit();
      if (request.action === 'status') {
        const s = this.options.arbiter.state(), d = this.display();
        this.complete(command.job_id, { status: 'succeeded', owner: s.owner, epoch: s.epoch, leaseUntil: s.leaseUntil, display: d, screenshotRequired: true });
      } else if (request.action === 'receipt') {
        const r = this.row(request.jobId);
        if (!r || r.thread_id !== command.route.execution_scope.thread_id || r.job_id === command.job_id) throw new ComputerEdgeError('computer_receipt_not_found', 404);
        this.complete(command.job_id, { jobId: r.job_id, ...JSON.parse(r.summary), delivered: Boolean(r.delivered), replayAllowed: false });
      } else {
        const epoch = request.epoch, d = this.display();
        this.assertLease(epoch, d);
        if (request.action === 'act') this.consumeObservation(command, request, d);
        // Durable intent already exists and the observation is consumed BEFORE
        // the Runtime acknowledges the physical side-effect boundary.
        await heartbeat(true);
        this.assertLease(epoch, d);
        const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(COMPUTER_EDGE_LIMITS.driverDeadlineMs)]);
        const assertCurrent = () => { this.assertLease(epoch, d, signal); assertPermit(); };
        const r = request;
        await this.options.arbiter.performAi(epoch, async () => {
          assertCurrent(); driverEntered = true;
          if (r.action === 'observe') {
            const started = this.now();
            const capture = await this.options.driver.capture({ signal, assertCurrent });
            assertCurrent();
            const bytes = Buffer.from(capture.png);
            if (capture.id !== d.id || capture.width !== d.width || capture.height !== d.height || !Number.isFinite(capture.capturedAt) || capture.capturedAt < started || capture.capturedAt > this.now() || bytes.length < 33 || bytes.length > COMPUTER_EDGE_LIMITS.screenshotBytes || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== d.width || bytes.readUInt32BE(20) !== d.height) throw new ComputerEdgeError('invalid_computer_capture', 502);
            const observationId = randomUUID();
            this.transaction(() => {
              this.db.prepare('INSERT INTO computer_edge_observations(scope,id,thread_id,epoch,display_id,width,height,expires_at) VALUES(?,?,?,?,?,?,?,?)')
                .run(this.scope, observationId, command!.route.execution_scope.thread_id, epoch, d.id, d.width, d.height, this.now() + COMPUTER_EDGE_LIMITS.observationMs);
              this.complete(command!.job_id, { status: 'observed', observationId, epoch, display: d, capturedAt: capture.capturedAt, sha256: hash(bytes) }, bytes);
            });
          } else {
            await this.options.driver.act(r.operation, { signal, assertCurrent });
            // A transfer/timeout during the call makes its business outcome
            // uncertain even when a helper reports successful dispatch.
            assertCurrent();
            this.complete(command!.job_id, { status: 'dispatched', epoch, externalEffects: 'unverified', replayAllowed: false });
          }
        });
      }
    } catch (error) {
      operationAbort.abort();
      const code = error instanceof ComputerEdgeError && SAFE_CODES.has(error.code) ? error.code : 'computer_operation_unconfirmed';
      const uncertain = driverEntered; // No physical driver was entered before this boundary.
      this.db.prepare('UPDATE computer_edge_journal SET state=?,summary=?,finish_json=? WHERE scope=? AND job_id=?')
        .run(uncertain ? 'unknown' : 'complete', JSON.stringify({ status: uncertain ? 'unknown' : 'rejected', code, replayAllowed: false }), JSON.stringify(failure(code)), this.scope, command.job_id);
      if (uncertain) await this.options.arbiter.pause(true, request && 'epoch' in request ? request.epoch : connectionEpoch);
    } finally { clearInterval(heartbeatTimer); await heartbeatQueue; }
    await this.deliver(command.job_id);
    return this.result(command.job_id);
  }
  private inspectObservation(id: string, threadId: string, epoch: number, display: ComputerDisplay) {
    const o = this.db.prepare('SELECT * FROM computer_edge_observations WHERE scope=? AND id=?').get(this.scope, id) as unknown as Observation | undefined;
    if (!o || o.thread_id !== threadId || o.epoch !== epoch || o.display_id !== display.id || o.width !== display.width || o.height !== display.height || o.expires_at <= this.now() || o.used_by) throw new ComputerEdgeError('computer_observation_stale');
    return o;
  }
  /** Internal approval UI adapter only: exact observed image, not a newer preview.
   * Caller must authorize the current fixed Principal before serving these bytes. */
  approvalObservation(id: string, threadId: string, epoch: number) {
    this.open(); this.assertLease(epoch); this.inspectObservation(id, threadId, epoch, this.display());
    const row = this.db.prepare("SELECT finish_json FROM computer_edge_journal WHERE scope=? AND thread_id=? AND json_extract(summary,'$.observationId')=? AND expires_at>?").get(this.scope, threadId, id, this.now()) as { finish_json: string | null } | undefined;
    if (!row?.finish_json) throw new ComputerEdgeError('computer_observation_stale');
    const output = JSON.parse(JSON.parse(row.finish_json).output)._morphz_tool_result;
    const metadata = JSON.parse(output.text);
    return { ...metadata, png: Buffer.from(output.model_attachments[0].data_base64, 'base64') } as { observationId: string; epoch: number; display: ComputerDisplay; capturedAt: number; sha256: string; png: Buffer };
  }
  private consumeObservation(command: ComputerEdgeCommand, request: Extract<ComputerToolRequest, { action: 'act' }>, display: ComputerDisplay) {
    this.transaction(() => {
      const o = this.inspectObservation(request.observationId, command.route.execution_scope.thread_id, request.epoch, display);
      const action: ComputerAction = request.operation;
      if (('x' in action && action.x >= display.width) || ('y' in action && action.y >= display.height)) throw new ComputerEdgeError('computer_coordinates_out_of_bounds', 400);
      this.db.prepare('UPDATE computer_edge_observations SET used_by=? WHERE scope=? AND id=? AND used_by IS NULL').run(command.job_id, this.scope, o.id);
    });
  }
  private complete(jobId: string, summary: Record<string, unknown>, image?: Buffer) {
    const text = JSON.stringify(summary);
    const output = image ? JSON.stringify({ _morphz_tool_result: { version: 1, text, model_attachments: [{ name: 'desktop.png', media_type: 'image/png', data_base64: image.toString('base64') }] } }) : text;
    this.db.prepare("UPDATE computer_edge_journal SET state='complete',summary=?,finish_json=? WHERE scope=? AND job_id=?").run(text, JSON.stringify({ status: 'succeeded', output, error: null }), this.scope, jobId);
  }
  private result(jobId: string) { const r = this.row(jobId)!; return { jobId, state: JSON.parse(r.summary).status as string, delivered: Boolean(r.delivered) }; }
  private async deliver(jobId: string) {
    const r = this.row(jobId)!;
    if (r.delivered) return;
    if (!r.finish_json || !r.lease_json || r.expires_at <= this.now()) throw new ComputerEdgeError('computer_result_expired', 410);
    try {
      const lease = JSON.parse(r.lease_json) as ComputerEdgeLease;
      const authorizeAbort = new AbortController();
      const signal = AbortSignal.any([this.lifetime.signal, authorizeAbort.signal]);
      const timer = setTimeout(() => authorizeAbort.abort(), 10_000);
      let onAbort!: () => void;
      try {
        if (signal.aborted) throw new ComputerEdgeError('computer_operation_revoked');
        await Promise.race([
          this.options.authorize(lease.route.execution_scope, { action: 'receipt', jobId }, { jobId, signal, expiresAt: this.now() + 10_000 }),
          new Promise<never>((_, reject) => { onAbort = () => reject(new ComputerEdgeError('computer_authorization_expired')); signal.addEventListener('abort', onAbort, { once: true }); }),
        ]);
      } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
      if (signal.aborted) throw new ComputerEdgeError('computer_operation_revoked');
      await this.options.transport.finish(lease, JSON.parse(r.finish_json) as ComputerEdgeFinish, this.lifetime.signal);
      this.db.prepare('UPDATE computer_edge_journal SET delivered=1 WHERE scope=? AND job_id=?').run(this.scope, jobId);
    } catch {
      // Preserve the exact cached envelope; do not repeat input. Only revoke the
      // epoch that produced it, never a newer human transfer.
      const summary = JSON.parse(r.summary) as { epoch?: number };
      if (summary.epoch !== undefined) await this.options.arbiter.pause(false, summary.epoch);
    }
  }
  /** Local maintenance only. Expired retry payloads are never reused. SQL row
   * removal is not forensic erasure from WAL, backups or native Runtime storage. */
  expireRetained() { this.open(); this.purge(); }
  async retryFinish(jobId: string) {
    this.open(); if (this.busy) throw new ComputerEdgeError('computer_worker_busy');
    if (!edgeId(jobId) || !this.row(jobId)) throw new ComputerEdgeError('computer_receipt_not_found', 404);
    this.purge(); this.busy = true;
    const work = this.deliver(jobId); this.active = work;
    try { await work; return this.result(jobId); } finally { this.busy = false; this.active = undefined; }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.lifetime.abort(); this.options.transport.close();
    await this.options.arbiter.pause(); await this.active?.catch(() => {});
    if (this.ownDb) this.db.close();
  }
}
