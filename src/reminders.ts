import { DatabaseSync } from 'node:sqlite';
import { randomUUID,createHash } from 'node:crypto';
export interface NativeSchedule {id:string;revision:number;status:'queued'|'paused'|'dispatched'|'completed'|'cancelled';intent:string;not_before:string|null;interval_seconds:number|null;[key:string]:unknown}
export interface ScheduleAdapter {
 createSchedule(sessionId:string,input:{id:string;intent:string;not_before:string;interval_seconds?:number;dependency_thread_ids:string[]}):Promise<NativeSchedule>;
 getSchedule(sessionId:string,id:string):Promise<NativeSchedule>;
 controlSchedule(sessionId:string,id:string,input:{action:'pause'|'resume'|'cancel';expected_revision:number}):Promise<NativeSchedule>;
}
export interface ReminderInput {intent:string;at:string;timeZone:string;intervalSeconds?:number;idempotencyKey:string}
export class ReminderError extends Error {}
/** Product stores original timezone intent; actual trigger/dispatch authority is Morphz.
 * at is an unambiguous RFC3339 instant. Calendar/DST recurrence is NOT simulated by intervals.
 */
export class Reminders {
 private db:DatabaseSync;private adapter:ScheduleAdapter;private sessionId:string;private inFlight=new Map<string,{fingerprint:string;promise:Promise<NativeSchedule>}>();
 constructor(path:string,adapter:ScheduleAdapter,sessionId:string){this.db=new DatabaseSync(path);this.adapter=adapter;this.sessionId=sessionId;this.db.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS opendots_reminders(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,command_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT,error TEXT);`);}
 private record(id:string,state:string,receipt?:NativeSchedule,error?:string){
  const previous=this.db.prepare('SELECT state,receipt_json FROM opendots_reminders WHERE id=? AND session_id=?').get(id,this.sessionId) as {state:string;receipt_json:string|null}|undefined;
  if(previous?.state==='confirmed'&&state!=='confirmed')return;
  if(receipt&&previous?.receipt_json&&JSON.parse(previous.receipt_json).revision>receipt.revision)return;
  this.db.prepare('UPDATE opendots_reminders SET state=?,receipt_json=?,error=? WHERE id=? AND session_id=?').run(state,receipt?JSON.stringify(receipt):null,error??null,id,this.sessionId);
 }
 private checkReceipt(id:string,intent:string,r:NativeSchedule){if(!r||r.id!==id||r.intent!==intent||!Number.isSafeInteger(r.revision)||r.revision<1||!['queued','paused','dispatched','completed','cancelled'].includes(r.status))throw new ReminderError('Native reminder identity or revision conflicts');}

 private validate(input:ReminderInput,now:number){
  if(!input||Object.keys(input).some(k=>!['intent','at','timeZone','intervalSeconds','idempotencyKey'].includes(k)))throw new ReminderError('Unexpected reminder fields');
  if(typeof input.intent!=='string'||!input.intent.trim()||input.intent.length>4000)throw new ReminderError('Reminder intent is required');
  if(typeof input.idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.idempotencyKey))throw new ReminderError('A stable reminder command key is required');
  if(typeof input.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(input.at)||!Number.isFinite(Date.parse(input.at)))throw new ReminderError('Use an unambiguous RFC3339 reminder time with UTC offset');
  const [year,month,day]=input.at.slice(0,10).split('-').map(Number);const maxDay=new Date(Date.UTC(year,month,0)).getUTCDate();if(month<1||month>12||day<1||day>maxDay)throw new ReminderError('Reminder calendar date does not exist');
  if(Date.parse(input.at)<=now)throw new ReminderError('The reminder time must be in the future');
  try{new Intl.DateTimeFormat('en',{timeZone:input.timeZone}).format();}catch{throw new ReminderError('An IANA timezone is required');}
  if(typeof input.timeZone!=='string'||!input.timeZone)throw new ReminderError('An IANA timezone is required');
  if(input.intervalSeconds!==undefined&&(!Number.isSafeInteger(input.intervalSeconds)||input.intervalSeconds<60))throw new ReminderError('Interval must be at least 60 seconds; calendar recurrence is a separate feature');
 }
 async create(input:ReminderInput,now=Date.now()){
  if(!input||typeof input.idempotencyKey!=='string')throw new ReminderError('A stable reminder key is required');
  const fingerprint=JSON.stringify({intent:input.intent,at:input.at,timeZone:input.timeZone,intervalSeconds:input.intervalSeconds??null});
  const running=this.inFlight.get(input.idempotencyKey);if(running){if(running.fingerprint!==fingerprint)throw new ReminderError('Reminder key conflicts with another intent');return running.promise;}
  const promise=this.createOnce(input,now).finally(()=>this.inFlight.delete(input.idempotencyKey));this.inFlight.set(input.idempotencyKey,{fingerprint,promise});return promise;
 }
 private async createOnce(input:ReminderInput,now:number){
  const fingerprint=createHash('sha256').update(JSON.stringify({intent:input.intent,at:input.at,timeZone:input.timeZone,intervalSeconds:input.intervalSeconds??null})).digest('hex');
  let existing=this.db.prepare('SELECT * FROM opendots_reminders WHERE command_key=?').get(input.idempotencyKey) as any;
  if(existing){if(existing.session_id!==this.sessionId||existing.fingerprint!==fingerprint)throw new ReminderError('Reminder key conflicts with another intent');if(existing.state==='confirmed')return JSON.parse(existing.receipt_json) as NativeSchedule;}
  else{this.validate(input,now);const id=`reminder-${randomUUID()}`;this.db.prepare("INSERT INTO opendots_reminders(id,session_id,command_key,fingerprint,input_json,state) VALUES(?,?,?,?,?,'pending')").run(id,this.sessionId,input.idempotencyKey,fingerprint,JSON.stringify(input));existing={id};}
  // Reconcile uncertain create by exact stable schedule ID before retrying.
  try{const receipt=await this.adapter.getSchedule(this.sessionId,existing.id);this.checkReceipt(existing.id,input.intent,receipt);this.record(existing.id,'confirmed',receipt);return receipt;}
  catch(error){if(error instanceof ReminderError)throw error;if((error as {status?:number}).status!==404){this.record(existing.id,'unknown',undefined,'read_unconfirmed');throw new ReminderError('Cannot confirm existing reminder. Retry with the same key.');}}
  try{const receipt=await this.adapter.createSchedule(this.sessionId,{id:existing.id,intent:input.intent,not_before:new Date(input.at).toISOString(),...(input.intervalSeconds!==undefined?{interval_seconds:input.intervalSeconds}:{}),dependency_thread_ids:[]});this.checkReceipt(existing.id,input.intent,receipt);this.record(existing.id,'confirmed',receipt);return receipt;}
  catch{this.record(existing.id,'unknown',undefined,'create_unconfirmed');throw new ReminderError('Reminder acceptance is unconfirmed. Retry the same key; do not create a duplicate.');}
 }
 list(){return this.db.prepare('SELECT id,input_json,state,receipt_json,error FROM opendots_reminders WHERE session_id=? ORDER BY rowid DESC').all(this.sessionId).map((x:any)=>({id:x.id,input:JSON.parse(x.input_json),state:x.state,schedule:x.receipt_json?JSON.parse(x.receipt_json):null,error:x.error}));}
 async refresh(){for(const entry of this.list()){try{const receipt=await this.adapter.getSchedule(this.sessionId,entry.id);this.checkReceipt(entry.id,entry.input.intent,receipt);this.record(entry.id,'confirmed',receipt);}catch{this.db.prepare('UPDATE opendots_reminders SET error=? WHERE id=?').run('refresh_unavailable',entry.id);}}return this.list();}
 async control(id:string,action:'pause'|'resume'|'cancel',expectedRevision:number){
  if(!['pause','resume','cancel'].includes(action)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new ReminderError('Invalid schedule control');
  const entry=this.list().find(x=>x.id===id);if(!entry)throw new ReminderError('Reminder does not belong to this assistant');
  try{const receipt=await this.adapter.controlSchedule(this.sessionId,id,{action,expected_revision:expectedRevision});this.checkReceipt(id,entry.input.intent,receipt);this.record(id,'confirmed',receipt);return receipt;}
  catch(error){if((error as {status?:number}).status===409)throw new ReminderError('Reminder changed; refresh before controlling it');this.db.prepare('UPDATE opendots_reminders SET error=? WHERE id=?').run('control_unconfirmed',id);throw new ReminderError('Control outcome unconfirmed; refresh before retrying');}
 }
 close(){this.db.close();}
}
