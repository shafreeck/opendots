import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { parseComputerRequest, validateComputerBinding, type ComputerEdgeBinding, type ComputerExecutionScope, type ComputerToolRequest } from './computer-edge-types.ts';
import type { ComputerActionPermit } from './computer-edge-executor.ts';

export class ComputerApprovalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
interface Observation {
  observationId: string; epoch: number; display: { id: string; width: number; height: number };
  capturedAt: number; sha256: string; png: Buffer;
}
interface RequestIdentity { jobId: string; actionDigest?: string; signal: AbortSignal; expiresAt: number }
interface Row {
  id: string; job_id: string; thread_id: string; epoch: number; observation_id: string;
  action_hash: string; image_hash: string; display_id: string; status: string; revision: number;
  expires_at: number; created_at: number; summary_json: string;
}
interface Pending {
  row: Row; request: Extract<ComputerToolRequest, { action: 'act' }>; observation: Observation;
  promise: Promise<ComputerActionPermit>; resolve: (permit: ComputerActionPermit) => void;
  reject: (error: Error) => void; cleanup: () => void;
}
export interface ComputerApprovalsOptions {
  db: DatabaseSync; binding: ComputerEdgeBinding;
  /** Must confirm the saved native Principal/Session before every read/decision. */
  revalidate: () => Promise<void>;
  observation: (id: string, threadId: string, epoch: number) => Observation;
  state: () => { owner: string; epoch: number; leaseUntil: number; uncertainty?: boolean };
  now?: () => number;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(status: number, message: string): never { throw new ComputerApprovalError(status, message); }

/** Initial, concrete policy: observe/status/receipt are read-only; every physical
 * action requires one local user decision. No page-semantic classifier or blanket
 * allow rule is assumed. Typed text and images exist only in pending memory;
 * durable rows contain hashes, identities, bounded non-text summaries and decisions.
 */
export class ComputerApprovals {
  private options: ComputerApprovalsOptions;
  private pending = new Map<string, Pending>();
  private now: () => number;
  private closed = false;
  constructor(options: ComputerApprovalsOptions) {
    validateComputerBinding(options.binding);
    this.options = options; this.now = options.now ?? Date.now;
    options.db.exec(`CREATE TABLE IF NOT EXISTS computer_approval_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_action_approvals(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,thread_id TEXT NOT NULL,epoch INTEGER NOT NULL,observation_id TEXT NOT NULL,action_hash TEXT NOT NULL,image_hash TEXT NOT NULL,display_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,summary_json TEXT NOT NULL);`);
    const encoded=JSON.stringify(options.binding);
    const prior=options.db.prepare('SELECT value FROM computer_approval_binding WHERE singleton=1').get() as {value:string}|undefined;
    if(prior&&prior.value!==encoded)fail(409,'Computer approval storage belongs to another fixed binding');
    if(!prior)options.db.prepare('INSERT INTO computer_approval_binding VALUES(1,?)').run(encoded);
    // No saved decision is converted into permission after process loss.
    options.db.prepare("UPDATE computer_action_approvals SET status='expired',revision=revision+1 WHERE status='pending'").run();
  }
  private async access() { if(this.closed)fail(503,'Computer approvals are closed');try{await this.options.revalidate();}catch{fail(503,'Cannot verify current computer authority');}if(this.closed)fail(503,'Computer approvals are closed'); }
  private row(id:string) { return this.options.db.prepare('SELECT * FROM computer_action_approvals WHERE id=?').get(id) as unknown as Row|undefined; }
  private scope(scope:ComputerExecutionScope) {
    const b=this.options.binding;
    if(scope.principal_id!==b.principalId||scope.agent_id!==b.agentId||scope.context_id!==b.contextId||scope.session_id!==b.sessionId||typeof scope.thread_id!=='string'||!scope.thread_id||scope.thread_id.length>512)fail(403,'Computer request is outside the saved task authority');
  }
  private inspect(row:Row) {
    const state=this.options.state();
    if(state.owner!=='ai'||state.epoch!==row.epoch||state.leaseUntil<=this.now()||row.expires_at<=this.now())fail(409,'Computer control or this approval has expired');
    let observed:Observation;try{observed=this.options.observation(row.observation_id,row.thread_id,row.epoch);}catch{fail(409,'The exact observed screen is no longer available');}
    if(observed.observationId!==row.observation_id||observed.epoch!==row.epoch||observed.display.id!==row.display_id||observed.sha256!==row.image_hash||hash(observed.png)!==row.image_hash)fail(409,'The observed screen changed');
    return observed;
  }
  private settle(id:string,status:'approved'|'denied'|'expired'|'aborted',permit?:ComputerActionPermit) {
    const p=this.pending.get(id);if(!p)return;
    this.options.db.prepare('UPDATE computer_action_approvals SET status=?,revision=revision+1 WHERE id=? AND status=\'pending\'').run(status,id);
    this.pending.delete(id);p.cleanup();
    if(permit)p.resolve(permit);else p.reject(new ComputerApprovalError(409,status==='denied'?'Computer action denied':'Computer approval expired or was revoked'));
  }
  async authorize(scope:ComputerExecutionScope,raw:ComputerToolRequest,identity:RequestIdentity):Promise<void|ComputerActionPermit> {
    await this.access();this.scope(scope);
    const request=parseComputerRequest(JSON.stringify(raw));
    if(identity.signal.aborted)fail(409,'Computer request was revoked');
    if(request.action!=='act')return;
    if(typeof identity.jobId!=='string'||!identity.jobId||identity.jobId.length>512||identity.actionDigest!==hash(JSON.stringify(request.operation)))fail(400,'Exact native action identity is required');
    const expiresAt=Math.min(identity.expiresAt,this.now()+45_000);
    if(!Number.isFinite(expiresAt)||expiresAt<=this.now())fail(409,'Computer approval expired');
    const existing=this.options.db.prepare('SELECT * FROM computer_action_approvals WHERE job_id=?').get(identity.jobId) as unknown as Row|undefined;
    if(existing){const p=this.pending.get(existing.id);if(p&&existing.thread_id===scope.thread_id&&existing.epoch===request.epoch&&existing.observation_id===request.observationId&&existing.action_hash===identity.actionDigest)return p.promise;fail(409,'This computer action already has a decision or an interrupted request');}
    if(this.pending.size>=8)fail(429,'Too many pending computer approvals');
    let observation:Observation;try{observation=this.options.observation(request.observationId,scope.thread_id,request.epoch);}catch{fail(409,'The exact observed screen is unavailable');}
    if(!Buffer.isBuffer(observation.png)||observation.png.length<33||observation.png.length>1024*1024||!observation.png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||observation.png.toString('ascii',12,16)!=='IHDR'||observation.png.readUInt32BE(16)!==observation.display.width||observation.png.readUInt32BE(20)!==observation.display.height||hash(observation.png)!==observation.sha256)fail(409,'The observed screen is invalid');
    const op=request.operation;
    const summary=op.type==='type'?{type:'type',characters:op.text.length}:{...op};
    const row:Row={id:randomUUID(),job_id:identity.jobId,thread_id:scope.thread_id,epoch:request.epoch,observation_id:request.observationId,action_hash:identity.actionDigest,image_hash:observation.sha256,display_id:observation.display.id,status:'pending',revision:1,expires_at:expiresAt,created_at:this.now(),summary_json:JSON.stringify({action:summary,objectiveId:scope.objective_id??null})};
    this.inspect(row);
    this.options.db.prepare('INSERT INTO computer_action_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.job_id,row.thread_id,row.epoch,row.observation_id,row.action_hash,row.image_hash,row.display_id,row.status,row.revision,row.expires_at,row.created_at,row.summary_json);
    let resolve!:(permit:ComputerActionPermit)=>void,reject!:(error:Error)=>void;
    const promise=new Promise<ComputerActionPermit>((yes,no)=>{resolve=yes;reject=no;});
    const abort=()=>this.settle(row.id,'aborted');
    const timer=setTimeout(()=>this.settle(row.id,'expired'),Math.max(1,expiresAt-this.now()));timer.unref();
    this.pending.set(row.id,{row,request,observation:{...observation,png:Buffer.from(observation.png)},promise,resolve,reject,cleanup:()=>{clearTimeout(timer);identity.signal.removeEventListener('abort',abort);}});
    identity.signal.addEventListener('abort',abort,{once:true});if(identity.signal.aborted)abort();
    return promise;
  }
  pendingCount() { return [...this.pending.values()].filter(p=>p.row.expires_at>this.now()).length; }
  async list() {
    await this.access();
    const rows=this.options.db.prepare('SELECT * FROM computer_action_approvals ORDER BY created_at DESC,id LIMIT 50').all() as unknown as Row[];
    return {approvals:rows.map(row=>{const pending=this.pending.get(row.id);const summary=JSON.parse(row.summary_json);return {objectiveId:summary.objectiveId,id:row.id,revision:row.revision,status:row.status,jobId:row.job_id,threadId:row.thread_id,epoch:row.epoch,observationId:row.observation_id,expiresAt:row.expires_at,action:pending?structuredClone(pending.request.operation):summary.action,imagePath:pending?`/api/computer/approvals/${row.id}/image`:null,display:pending?.observation.display??null,capturedAt:pending?.observation.capturedAt??null,actionable:Boolean(pending)&&row.expires_at>this.now(),priorUncertainty:this.options.state().uncertainty===true};})};
  }
  async image(id:string) { await this.access();const p=this.pending.get(id);if(!p)fail(410,'This approval image is no longer retained');this.inspect(p.row);return Buffer.from(p.observation.png); }
  async decide(id:string,decision:'allow_once'|'deny',expectedRevision:number,assertAuthorized:()=>void=()=>{}) {
    const checkAuthorization=()=>{if(assertAuthorized()!==undefined)fail(403,'Synchronous owner authorization required');};
    checkAuthorization();await this.access();checkAuthorization();if(!['allow_once','deny'].includes(decision)||!Number.isSafeInteger(expectedRevision))fail(400,'Exact approval decision and displayed revision required');
    const row=this.row(id);const p=this.pending.get(id);
    if(!row||!p)fail(409,'This approval is no longer pending');
    if(row.status!=='pending'||row.revision!==expectedRevision)fail(409,'Approval revision changed');
    if(decision==='deny'){checkAuthorization();this.settle(id,'denied');return {id,status:'denied',revision:row.revision+1};}
    try{this.inspect(row);}catch{this.settle(id,'expired');fail(409,'Computer authority or observed screen changed; nothing was approved');}
    const permit:ComputerActionPermit={approved:true,receiptId:row.id,jobId:row.job_id,threadId:row.thread_id,epoch:row.epoch,observationId:row.observation_id,actionDigest:row.action_hash,expiresAt:row.expires_at};
    checkAuthorization();this.settle(id,'approved',permit);return {id,status:'approved',revision:row.revision+1};
  }
  close() { if(this.closed)return;this.closed=true;for(const id of [...this.pending.keys()])this.settle(id,'aborted'); }
}
