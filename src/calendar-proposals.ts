import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { calendarSeriesId, validateCalendarRule, type CalendarRule } from './calendar-reminders.ts';
import { connectorJson, type ConnectorInvocation, type Json } from './connector-types.ts';
import type { NativeHostEnvelope } from './native-host-authority.ts';

export const CALENDAR_TOOL='host_opendots_calendar';
export const calendarProposalLimits={pending:20,total:200,page:20,receiptBytes:262_144}as const;
export class CalendarProposalError extends Error {readonly code:string;readonly status:number;constructor(code:string,status=409){super(code);this.name='CalendarProposalError';this.code=code;this.status=status;}}
function check(value:unknown,code:string,status=409):asserts value{if(!value)throw new CalendarProposalError(code,status);}
const hash=(value:unknown)=>createHash('sha256').update(connectorJson(value,262_144)).digest('hex');
interface ProposalRow{id:string;owner_id:string;session_id:string;job_id:string;call_id:string;thread_id:string;rule_json:string;rule_hash:string;preview_json:string;state:'pending_owner_confirmation'|'admitted'|'dismissed';revision:number;decision_from_revision:number|null;series_key:string|null;series_id:string|null;created_at:number;decision_at:number|null;}
export interface CalendarProposalView {proposalId:string;revision:number;state:ProposalRow['state'];rule:CalendarRule;ruleFingerprint:string;preview:Json;provenance:{jobId:string;callId:string;threadId:string};createdAt:number;decisionAt:number|null;requiresOwnerConfirmation:boolean;scheduling:'not_admitted'|'series_admitted';seriesId:string|null;}
/** Private product candidate state only. This class has no native schedule adapter.
 * Native callers can propose/read; only an owner-scoped synchronous calendar
 * admission guard may atomically record a human decision and a series intent. */
export class CalendarProposals {
  private db:DatabaseSync;private ownerId:string;private sessionId:string;private now:()=>number;
  constructor(options:{db:DatabaseSync;ownerId:string;sessionId:string;now?:()=>number}){
    check(/^[A-Za-z0-9_.:-]{1,512}$/.test(options.ownerId)&&/^[A-Za-z0-9_.:-]{1,512}$/.test(options.sessionId),'calendar_proposal_binding_required');
    this.db=options.db;this.ownerId=options.ownerId;this.sessionId=options.sessionId;this.now=options.now??Date.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS calendar_proposals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,job_id TEXT NOT NULL,call_id TEXT NOT NULL,thread_id TEXT NOT NULL,rule_json TEXT NOT NULL,rule_hash TEXT NOT NULL,preview_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,decision_from_revision INTEGER,series_key TEXT,series_id TEXT,created_at INTEGER NOT NULL,decision_at INTEGER,UNIQUE(owner_id,session_id,job_id,call_id));
      CREATE TABLE IF NOT EXISTS calendar_proposal_tool_receipts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,arguments_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  private transaction<T>(operation:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=operation();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private callId(e:NativeHostEnvelope){check(e.tool===CALENDAR_TOOL&&e.invocation.session_id===this.sessionId,'calendar_proposal_scope_denied',403);return `calcall-${hash([this.ownerId,this.sessionId,e.tool,e.invocation.job_id,e.invocation.tool_call_id])}`;}
  receipt(e:NativeHostEnvelope):Json|null{const id=this.callId(e),r=this.db.prepare('SELECT arguments_hash,result_json FROM calendar_proposal_tool_receipts WHERE id=? AND owner_id=? AND session_id=?').get(id,this.ownerId,this.sessionId)as{arguments_hash:string;result_json:string}|undefined;if(!r)return null;check(r.arguments_hash===hash(e),'calendar_proposal_call_conflict');return JSON.parse(r.result_json)as Json;}
  private putReceipt(e:NativeHostEnvelope,result:Json){this.db.prepare('INSERT INTO calendar_proposal_tool_receipts VALUES(?,?,?,?,?,?)').run(this.callId(e),this.ownerId,this.sessionId,hash(e),connectorJson(result,calendarProposalLimits.receiptBytes),this.now());return result;}
  recordReceipt(e:NativeHostEnvelope,result:Json){return this.transaction(()=>this.receipt(e)??this.putReceipt(e,result));}
  private row(id:string):ProposalRow{check(/^calprop-[a-f0-9]{64}$/.test(id),'calendar_proposal_not_found',404);const row=this.db.prepare('SELECT * FROM calendar_proposals WHERE id=? AND owner_id=? AND session_id=?').get(id,this.ownerId,this.sessionId)as unknown as ProposalRow|undefined;check(row,'calendar_proposal_not_found',404);return row;}
  private view(r:ProposalRow):CalendarProposalView{return{proposalId:r.id,revision:r.revision,state:r.state,rule:JSON.parse(r.rule_json),ruleFingerprint:r.rule_hash,preview:JSON.parse(r.preview_json),provenance:{jobId:r.job_id,callId:r.call_id,threadId:r.thread_id},createdAt:r.created_at,decisionAt:r.decision_at,requiresOwnerConfirmation:r.state==='pending_owner_confirmation',scheduling:r.state==='admitted'?'series_admitted':'not_admitted',seriesId:r.series_id};}
  read(id:string){return this.view(this.row(id));}
  list(input:{afterId?:string;limit?:number}={}){const limit=input.limit??calendarProposalLimits.page;check(Number.isInteger(limit)&&limit>=1&&limit<=calendarProposalLimits.page,'calendar_proposal_page_invalid',400);check(input.afterId===undefined||/^calprop-[a-f0-9]{64}$/.test(input.afterId),'calendar_proposal_page_invalid',400);const rows=this.db.prepare('SELECT * FROM calendar_proposals WHERE owner_id=? AND session_id=? AND id>? ORDER BY id LIMIT ?').all(this.ownerId,this.sessionId,input.afterId??'',limit)as unknown as ProposalRow[];return{proposals:rows.map(r=>this.view(r)),nextCursor:rows.length===limit?rows.at(-1)!.id:null};}
  countPending(){return Number((this.db.prepare("SELECT count(*) AS n FROM calendar_proposals WHERE owner_id=? AND session_id=? AND state='pending_owner_confirmation'").get(this.ownerId,this.sessionId)as{n:number}).n);}
  propose(e:NativeHostEnvelope,ruleInput:unknown,preview:unknown):Json{
    const rule=validateCalendarRule(ruleInput),previewJson=connectorJson(preview,32_768);
    return this.transaction(()=>{const old=this.receipt(e);if(old)return old;const count=this.db.prepare("SELECT count(*) AS total,sum(CASE WHEN state='pending_owner_confirmation' THEN 1 ELSE 0 END) AS pending FROM calendar_proposals WHERE owner_id=? AND session_id=?").get(this.ownerId,this.sessionId)as{total:number;pending:number|null};check(Number(count.total)<calendarProposalLimits.total&&Number(count.pending??0)<calendarProposalLimits.pending,'calendar_proposal_limit');
      const id=`calprop-${hash([this.ownerId,this.sessionId,e.tool,e.invocation.job_id,e.invocation.tool_call_id])}`,i:ConnectorInvocation=e.invocation;
      this.db.prepare("INSERT INTO calendar_proposals(id,owner_id,session_id,job_id,call_id,thread_id,rule_json,rule_hash,preview_json,state,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending_owner_confirmation',1,?)").run(id,this.ownerId,this.sessionId,i.job_id,i.tool_call_id,i.thread_id,JSON.stringify(rule),hash(rule),previewJson,this.now());
      return this.putReceipt(e,{proposal:this.read(id)as unknown as Json,requiresOwnerConfirmation:true,scheduling:'not_admitted'});
    });
  }
  confirmation(id:string){const row=this.row(id);return{proposal:this.view(row),seriesKey:`proposal-${row.id}`,seriesId:calendarSeriesId({ownerId:this.ownerId,sessionId:this.sessionId},`proposal-${row.id}`)};}
  /** Runs ONLY inside CalendarReminders.create's existing SQLite transaction. */
  confirmInsideAdmission(id:string,expectedRevision:number,ruleFingerprint:string){
    check(this.db.isTransaction,'calendar_proposal_admission_transaction_required');const r=this.row(id),c=this.confirmation(id);
    check(Number.isSafeInteger(expectedRevision)&&expectedRevision>=1&&r.rule_hash===ruleFingerprint,'calendar_proposal_revision_conflict');
    if(r.state==='admitted'){check(r.decision_from_revision===expectedRevision&&r.series_key===c.seriesKey&&r.series_id===c.seriesId,'calendar_proposal_revision_conflict');return;}
    check(r.state==='pending_owner_confirmation'&&r.revision===expectedRevision,'calendar_proposal_revision_conflict');
    this.db.prepare("UPDATE calendar_proposals SET state='admitted',revision=revision+1,decision_from_revision=?,series_key=?,series_id=?,decision_at=? WHERE id=?").run(expectedRevision,c.seriesKey,c.seriesId,this.now(),id);
  }
  dismiss(id:string,expectedRevision:number,admissionGuard:()=>void){return this.transaction(()=>{const result:unknown=admissionGuard();if(result instanceof Promise)void result.catch(()=>undefined);check(result===undefined,'calendar_proposal_guard_must_be_synchronous');const r=this.row(id);check(Number.isSafeInteger(expectedRevision)&&expectedRevision>=1,'calendar_proposal_revision_conflict');if(r.state==='dismissed'){check(r.decision_from_revision===expectedRevision,'calendar_proposal_revision_conflict');return this.view(r);}check(r.state!=='admitted','calendar_proposal_already_admitted');check(r.revision===expectedRevision,'calendar_proposal_revision_conflict');this.db.prepare("UPDATE calendar_proposals SET state='dismissed',revision=revision+1,decision_from_revision=?,decision_at=? WHERE id=?").run(expectedRevision,this.now(),id);return this.read(id);});}
}
