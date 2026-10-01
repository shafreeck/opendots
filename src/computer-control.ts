import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Controller = 'human' | 'ai';
export interface ComputerState {
  sessionId: string;
  owner: Controller | 'paused' | 'transition';
  epoch: number;
  leaseUntil: number;
  observationId: string | null;
  uncertainty: boolean;
}
export interface ControlLease { sessionId: string; owner: Controller; epoch: number; }
export class ControlConflict extends Error {}

/** Single-process control arbiter. Every actual CDP/RFB/OS input path MUST use it.
 * It cannot enforce ownership against a client with direct VNC/CDP access.
 * Reopening always pauses; previous authority is never automatically restored.
 */
export class ComputerControl {
  private db: DatabaseSync;
  private active = new Map<string, Promise<void>>();
  private closed = false;
  private now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS computer_control(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        epoch INTEGER NOT NULL,lease_until INTEGER NOT NULL,observation_id TEXT,uncertainty INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS computer_control_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL);
      UPDATE computer_control SET owner='paused',epoch=epoch+1,lease_until=0,observation_id=NULL;`);
  }
  private assertOpen() { if (this.closed) throw new ControlConflict('Control arbiter is closed'); }
  private transaction<T>(fn: () => T): T {
    this.assertOpen(); this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private log(state: ComputerState, event: string) {
    this.db.prepare('INSERT INTO computer_control_audit(session_id,epoch,event,created_at) VALUES(?,?,?,?)')
      .run(state.sessionId,state.epoch,event,this.now());
  }
  private write(s: ComputerState) {
    this.db.prepare('UPDATE computer_control SET owner=?,epoch=?,lease_until=?,observation_id=?,uncertainty=? WHERE session_id=?')
      .run(s.owner,s.epoch,s.leaseUntil,s.observationId,Number(s.uncertainty),s.sessionId);
  }
  state(sessionId: string): ComputerState {
    this.assertOpen();
    const r = this.db.prepare('SELECT * FROM computer_control WHERE session_id=?').get(sessionId) as
      {session_id:string;owner:ComputerState['owner'];epoch:number;lease_until:number;observation_id:string|null;uncertainty:number}|undefined;
    if (!r) throw new ControlConflict('Unknown computer session');
    return {sessionId:r.session_id,owner:r.owner,epoch:r.epoch,leaseUntil:r.lease_until,observationId:r.observation_id,uncertainty:Boolean(r.uncertainty)};
  }
  createSession(sessionId: string = randomUUID()): ComputerState {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new ControlConflict('Invalid computer session ID');
    return this.transaction(() => {
      this.db.prepare("INSERT INTO computer_control(session_id,owner,epoch,lease_until) VALUES(?,'paused',0,0)").run(sessionId);
      const s=this.state(sessionId); this.log(s,'session.created'); return s;
    });
  }
  private validLease(lease: ControlLease): ComputerState {
    const s=this.state(lease.sessionId);
    if (s.owner!==lease.owner || s.epoch!==lease.epoch || s.leaseUntil<=this.now()) throw new ControlConflict('Control lease expired or was revoked');
    return s;
  }
  renew(lease: ControlLease, ttlMs = 30_000): ComputerState {
    if (!Number.isFinite(ttlMs)||ttlMs<1||ttlMs>60_000) throw new ControlConflict('Invalid lease duration');
    return this.transaction(()=>{const s=this.validLease(lease);s.leaseUntil=this.now()+ttlMs;this.write(s);return s;});
  }
  /** Invalidate queued actions immediately; acknowledge takeover only after in-flight action settles.
   * A failed/uncertain action is surfaced; takeover never claims to undo it.
   */
  async takeover(sessionId:string):Promise<ComputerState> { return this.transfer(sessionId,'human'); }
  /** capture must be a trusted fresh screenshot/DOM read of THIS same live session. */
  async returnToAi(sessionId:string,capture:()=>Promise<{id:string;capturedAt:number}>,assertAuthorized:()=>void=()=>{}):Promise<ComputerState> {
    return this.transfer(sessionId,'ai',capture,assertAuthorized);
  }
  private async transfer(sessionId:string,target:Controller,capture?:()=>Promise<{id:string;capturedAt:number}>,assertAuthorized:()=>void=()=>{}):Promise<ComputerState> {
    const transition=this.transaction(()=>{
      const s=this.state(sessionId);
      if(s.owner==='transition') throw new ControlConflict('A control transfer is already pending');
      s.owner='transition';s.epoch++;s.leaseUntil=0;s.observationId=null;this.write(s);this.log(s,`transfer.requested.${target}`);return s;
    });
    const currentAction=this.active.get(sessionId);
    if(currentAction) await currentAction;
    let observation:{id:string;capturedAt:number}|undefined;
    try {
      if(target==='ai') {
        const started=this.now(); observation=await capture!();
        if(!observation.id || observation.capturedAt<started || observation.capturedAt>this.now()) throw new ControlConflict('Fresh observation required');
      }
      return this.transaction(()=>{
        const s=this.state(sessionId);
        if(s.epoch!==transition.epoch||s.owner!=='transition') throw new ControlConflict('Control transfer revoked');
        // Synchronous final grant boundary: no await/microtask can separate the
        // owner-session authorization check from persisting the new authority.
        if (assertAuthorized() !== undefined) throw new ControlConflict('Synchronous owner authorization required');
        s.owner=target;s.leaseUntil=this.now()+30_000;s.observationId=observation?.id??null;this.write(s);this.log(s,`transfer.granted.${target}`);return s;
      });
    } catch(e) {
      this.transaction(()=>{const s=this.state(sessionId);if(s.epoch===transition.epoch){s.owner='paused';s.epoch++;s.leaseUntil=0;this.write(s);this.log(s,'transfer.failed');}});
      throw e;
    }
  }
  /** The passed callback is the only permitted physical action entry point. No local queue.
   * An old lease is checked immediately before dispatch, never only at queue admission.
   */
  async perform<T>(lease:ControlLease,action:()=>Promise<T>):Promise<T> {
    this.validLease(lease);
    if(this.active.has(lease.sessionId)) throw new ControlConflict('Another computer action is in flight');
    let release!:()=>void;
    const settled=new Promise<void>(resolve=>{release=resolve;});
    this.active.set(lease.sessionId,settled);
    this.log(this.state(lease.sessionId),'action.dispatched');
    try { return await action(); }
    catch(e) {
      this.transaction(()=>{const s=this.state(lease.sessionId);s.uncertainty=true;this.write(s);this.log(s,'action.uncertain');});
      throw e;
    } finally {
      this.active.delete(lease.sessionId);release();
    }
  }
  /** Trusted recovery evidence only; never grants or revokes an ownership lease. */
  noteUncertainty(sessionId:string):ComputerState {
    return this.transaction(()=>{const s=this.state(sessionId);s.uncertainty=true;this.write(s);this.log(s,'input.repair_required');return s;});
  }
  /** Disconnection/lease expiry never returns authority to AI. */
  pause(sessionId:string, uncertain = false, expectedEpoch?: number):ComputerState {
    return this.transaction(()=>{const s=this.state(sessionId);if(expectedEpoch!==undefined&&s.epoch!==expectedEpoch){if(uncertain){s.uncertainty=true;this.write(s);this.log(s,'action.late_uncertainty');}return s;}s.owner='paused';s.epoch++;s.leaseUntil=0;s.observationId=null;s.uncertainty=s.uncertainty||uncertain;this.write(s);this.log(s,uncertain?'session.paused_uncertain':'session.paused');return s;});
  }
  audit(sessionId:string) { return this.db.prepare('SELECT epoch,event,created_at FROM computer_control_audit WHERE session_id=? ORDER BY id').all(sessionId); }
  close() { if(this.active.size)throw new ControlConflict('Cannot close while physical actions are in flight');this.closed=true;this.db.close(); }
}
