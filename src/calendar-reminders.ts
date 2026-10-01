import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativeSchedule, ScheduleAdapter } from './reminders.ts';

export interface CalendarRule {
  intent: string; timeZone: string; frequency: 'daily' | 'weekly'; localTime: string;
  startDate: string; untilDate?: string; weekdays?: number[];
  dst: { gap: 'skip'; overlap: 'earlier' | 'later' };
  missed: 'skip_unsubmitted';
  resume: 'skip_overdue_paused';
}
export interface CalendarCreateInput extends CalendarRule { idempotencyKey: string }
export interface CalendarOccurrenceTime {
  localDate: string; localTime: string; timeZone: string; instant: string; offset: string;
  ambiguous: boolean; overlap: 'earlier' | 'later'; calculationVersion: string;
}
export interface CalendarControlInput { action: 'pause' | 'resume' | 'cancel'; expectedRevision: number; idempotencyKey: string }
export interface CalendarReminderOptions {
  db: DatabaseSync; adapter: ScheduleAdapter; binding: { ownerId: string; sessionId: string };
  /** Live fixed-owner policy check. Native scheduler remains execution authority. */
  authorize: () => Promise<void>; now?: () => number;
}
export class CalendarReminderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'CalendarReminderError'; this.code = code; }
}
const DAY = 86_400_000, MINUTE = 60_000;
export const calendarLimits = { preview: 5, searchDays: 32, offsetMinutes: 1_440, candidateChecks: 60_000, page: 50, series: 200 } as const;
export const calendarCalculationVersion = `opendots-calendar-v1;node=${process.versions.node};icu=${process.versions.icu ?? 'unknown'};tz=${process.versions.tz ?? 'unknown'}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function check(value: unknown, code = 'calendar_invalid_input'): asserts value { if (!value) throw new CalendarReminderError(code); }
function record(value: unknown): Record<string, unknown> { check(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) { check(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k))); }
function key(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(value); }
export function calendarSeriesId(binding:{ownerId:string;sessionId:string},commandKey:string){check(identifier(binding.ownerId)&&identifier(binding.sessionId)&&key(commandKey),'calendar_command_key_required');return `cal-${hash([binding.ownerId,binding.sessionId,commandKey])}`;}
function dateMs(value: unknown): number {
  check(typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value), 'calendar_date_invalid');
  const result = Date.parse(value + 'T00:00:00.000Z'); check(Number.isFinite(result) && new Date(result).toISOString().slice(0,10) === value, 'calendar_date_invalid'); return result;
}
const dateString = (value: number) => new Date(value).toISOString().slice(0,10);
function formatter(timeZone: string) {
  try { return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new CalendarReminderError('calendar_time_zone_invalid'); }
}
function parts(format: Intl.DateTimeFormat, instant: number) {
  const p = Object.fromEntries(format.formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type,p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, second: p.second };
}
export function validateCalendarRule(value: unknown): CalendarRule {
  const r = record(value); exact(r, ['intent','timeZone','frequency','localTime','startDate','dst','missed','resume'], ['untilDate','weekdays']);
  check(typeof r.intent === 'string' && r.intent.trim().length > 0 && r.intent.length <= 4_000);
  check(typeof r.timeZone === 'string' && /^[A-Za-z][A-Za-z0-9_+/-]{0,99}$/.test(r.timeZone), 'calendar_time_zone_invalid'); formatter(r.timeZone);
  check(typeof r.localTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(r.localTime), 'calendar_time_invalid');
  const start = dateMs(r.startDate); if (r.untilDate !== undefined) check(dateMs(r.untilDate) >= start, 'calendar_date_invalid');
  check(r.frequency === 'daily' || r.frequency === 'weekly');
  if (r.frequency === 'daily') check(r.weekdays === undefined);
  else check(Array.isArray(r.weekdays) && r.weekdays.length >= 1 && r.weekdays.length <= 7 && r.weekdays.every((n,i,a) => Number.isInteger(n) && n >= 1 && n <= 7 && (i === 0 || a[i-1] < n)), 'calendar_weekdays_invalid');
  const dst = record(r.dst); exact(dst, ['gap','overlap']); check(dst.gap === 'skip' && typeof dst.overlap === 'string' && ['earlier','later'].includes(dst.overlap) && r.missed === 'skip_unsubmitted' && r.resume === 'skip_overdue_paused', 'calendar_policy_required');
  return { intent: r.intent, timeZone: r.timeZone, frequency: r.frequency, localTime: r.localTime, startDate: r.startDate as string, ...(r.untilDate !== undefined ? { untilDate: r.untilDate as string } : {}), ...(r.frequency === 'weekly' ? { weekdays: [...r.weekdays as number[]] } : {}), dst: { gap: 'skip', overlap: dst.overlap as 'earlier' | 'later' }, missed: 'skip_unsubmitted', resume: 'skip_overdue_paused' };
}
/** Exhaustive bounded minute-offset search, not a fixed-duration recurrence.
 * V1 intentionally supports modern 2000–2099 dates and minute wall-clock times.
 * All candidate instants must round-trip through the named zone exactly. */
function resolveMinute(rule: CalendarRule, localDate: string, format: Intl.DateTimeFormat, budget: { remaining: number }): CalendarOccurrenceTime | null {
  const wall = Date.parse(`${localDate}T${rule.localTime}:00.000Z`), candidates: Array<{ instant: number; offset: number }> = [];
  for (let offset = -calendarLimits.offsetMinutes; offset <= calendarLimits.offsetMinutes; offset++) {
    check(--budget.remaining >= 0, 'calendar_search_limit');
    const instant = wall - offset * MINUTE, p = parts(format, instant);
    if (p.date === localDate && p.time === rule.localTime && p.second === '00') candidates.push({ instant, offset });
  }
  if (candidates.length === 0) return null;
  check(candidates.length <= 2, 'calendar_zone_mapping_unsupported'); candidates.sort((a,b) => a.instant - b.instant);
  const selected = rule.dst.overlap === 'earlier' ? candidates[0]! : candidates.at(-1)!;
  const n = Math.abs(selected.offset), offset = `${selected.offset < 0 ? '-' : '+'}${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
  return { localDate, localTime: rule.localTime, timeZone: rule.timeZone, instant: new Date(selected.instant).toISOString(), offset, ambiguous: candidates.length === 2, overlap: rule.dst.overlap, calculationVersion: calendarCalculationVersion };
}
function next(rule: CalendarRule, after: number, afterDate: string | null, budget: { remaining: number }, skippedGaps: string[]): CalendarOccurrenceTime | null {
  check(Number.isFinite(after), 'calendar_instant_invalid'); const format = formatter(rule.timeZone);
  const today = parts(format, after).date;
  check(/^20\d\d-/.test(today), 'calendar_instant_out_of_range');
  let start = Math.max(dateMs(rule.startDate), dateMs(today), afterDate ? dateMs(afterDate) + DAY : -Infinity);
  for (let day = 0; day < calendarLimits.searchDays; day++) {
    const date = dateString(start + day * DAY);
    if (!/^20\d\d-/.test(date) || (rule.untilDate && date > rule.untilDate)) return null;
    const weekday = new Date(start + day * DAY).getUTCDay() || 7;
    if (rule.frequency === 'weekly' && !rule.weekdays!.includes(weekday)) continue;
    const occurrence = resolveMinute(rule, date, format, budget);
    if (!occurrence) { skippedGaps.push(date); continue; }
    if (Date.parse(occurrence.instant) > after) return occurrence;
  }
  throw new CalendarReminderError('calendar_search_limit');
}
export function previewCalendar(ruleInput: unknown, after = Date.now(), count = 3) {
  const rule = validateCalendarRule(ruleInput); check(Number.isInteger(count) && count >= 1 && count <= calendarLimits.preview);
  const occurrences: CalendarOccurrenceTime[] = [], skippedGaps: string[] = [], budget = { remaining: calendarLimits.candidateChecks as number }; let cursor: string | null = null;
  for (let n = 0; n < count; n++) { const occurrence = next(rule, after, cursor, budget, skippedGaps); if (!occurrence) break; occurrences.push(occurrence); cursor = occurrence.localDate; }
  return { rule, policy: { dst: rule.dst, missed: rule.missed, resume: rule.resume, admittedSchedulesMayDispatchLate: true }, calculationVersion: calendarCalculationVersion, occurrences, skippedGaps, exhausted: occurrences.length < count };
}

interface SeriesRow { id:string; owner_id:string; session_id:string; command_key:string; fingerprint:string; rule_json:string; desired:'active'|'paused'|'cancelled'; revision:number; current_id:string|null; cursor_date:string|null; error_code:string|null; control_requested:number; ended:number; created_at:number; updated_at:number }
interface NativeControl { action:'pause'|'resume'|'cancel'; expectedRevision:number; seriesRevision:number; purpose:'desired_state'|'resume_overdue'; attempted:boolean }
interface OccurrenceRow { id:string; series_id:string; local_date:string; time_json:string; attempted:number; state:'pending'|'unknown'|'confirmed'|'skipped'; receipt_json:string|null; control_json:string|null; error_code:string|null; hold_reason:string|null; advance_cancelled:number; resume_revision:number|null }
export interface CalendarSeriesView {
  id:string; revision:number; rule:CalendarRule; desiredState:SeriesRow['desired']; controlPending:boolean; ended:boolean; errorCode:string|null;
  recoveryDecisionRequired:boolean;
  createCommand:{idempotencyKey:string};latestControl:null|{idempotencyKey:string;action:'pause'|'resume'|'cancel';expectedRevision:number;admittedRevision:number};
  occurrence:null|{id:string;time:CalendarOccurrenceTime;state:OccurrenceRow['state'];createAttempted:boolean;schedule:NativeSchedule|null;controlPending:boolean;errorCode:string|null};
  alreadyDispatchedWork:'native_owned';
}
/** Product recurrence intent only. Explicit lifecycle reconciliation materializes
 * one not-yet-dispatched native one-shot. No local timer executes user work. */
export class CalendarReminders {
  private options:CalendarReminderOptions; private db:DatabaseSync; private now:()=>number;
  private queues=new Map<string,Promise<unknown>>(); private closed=false; private closing?:Promise<void>;
  private admitted=new Set<Promise<unknown>>();
  constructor(options:CalendarReminderOptions) {
    check(identifier(options.binding.ownerId) && identifier(options.binding.sessionId) && typeof options.authorize === 'function', 'calendar_binding_required');
    this.options={...options,binding:{...options.binding}};this.db=options.db;this.now=options.now??Date.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS calendar_series(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,command_key TEXT NOT NULL,fingerprint TEXT NOT NULL,rule_json TEXT NOT NULL,desired TEXT NOT NULL,revision INTEGER NOT NULL,current_id TEXT,cursor_date TEXT,error_code TEXT,control_requested INTEGER NOT NULL DEFAULT 0,ended INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner_id,session_id,command_key));
      CREATE TABLE IF NOT EXISTS calendar_occurrences(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,local_date TEXT NOT NULL,time_json TEXT NOT NULL,attempted INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,receipt_json TEXT,control_json TEXT,error_code TEXT,hold_reason TEXT,advance_cancelled INTEGER NOT NULL DEFAULT 0,resume_revision INTEGER,UNIQUE(series_id,local_date));
      CREATE TABLE IF NOT EXISTS calendar_commands(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,command_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result_revision INTEGER NOT NULL,action TEXT NOT NULL,UNIQUE(series_id,command_key));
      CREATE TABLE IF NOT EXISTS calendar_reconcile_cursor(owner_id TEXT NOT NULL,session_id TEXT NOT NULL,cursor TEXT,PRIMARY KEY(owner_id,session_id));`);
  }
  private open(){check(!this.closed,'calendar_closed');}
  private async authorized(){this.open();try{await this.options.authorize();}catch{throw new CalendarReminderError('calendar_authorization_unavailable');}this.open();}
  private transaction<T>(operation:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private row(id:string):SeriesRow {const b=this.options.binding;const row=this.db.prepare('SELECT * FROM calendar_series WHERE id=? AND owner_id=? AND session_id=?').get(id,b.ownerId,b.sessionId) as unknown as SeriesRow|undefined;check(row,'calendar_series_not_found');return row;}
  private occurrence(id:string|null):OccurrenceRow|null {return id?this.db.prepare('SELECT * FROM calendar_occurrences WHERE id=?').get(id) as unknown as OccurrenceRow??null:null;}
  private view(s:SeriesRow):CalendarSeriesView {const o=this.occurrence(s.current_id),command=this.db.prepare('SELECT command_key,action,result_revision FROM calendar_commands WHERE series_id=? ORDER BY result_revision DESC LIMIT 1').get(s.id) as {command_key:string;action:'pause'|'resume'|'cancel';result_revision:number}|undefined;return {id:s.id,revision:s.revision,rule:JSON.parse(s.rule_json),desiredState:s.desired,controlPending:Boolean(s.control_requested||o?.control_json||o?.hold_reason),ended:Boolean(s.ended),errorCode:s.error_code,recoveryDecisionRequired:Boolean(o?.hold_reason&&!o.control_json&&o.state==='confirmed'&&o.receipt_json&&['queued','paused','cancelled'].includes((JSON.parse(o.receipt_json) as NativeSchedule).status)),createCommand:{idempotencyKey:s.command_key},latestControl:command?{idempotencyKey:command.command_key,action:command.action,expectedRevision:command.result_revision-1,admittedRevision:command.result_revision}:null,occurrence:o?{id:o.id,time:JSON.parse(o.time_json),state:o.state,createAttempted:Boolean(o.attempted),schedule:o.receipt_json?JSON.parse(o.receipt_json):null,controlPending:Boolean(o.control_json||o.hold_reason),errorCode:o.error_code}:null,alreadyDispatchedWork:'native_owned'};}
  private enqueue<T>(id:string,operation:()=>Promise<T>):Promise<T> {this.open();const previous=this.queues.get(id)??Promise.resolve();const running=previous.catch(()=>undefined).then(()=>{this.open();return operation();});this.queues.set(id,running);void running.finally(()=>{if(this.queues.get(id)===running)this.queues.delete(id);}).catch(()=>undefined);return running;}
  private admit<T>(operation:()=>Promise<T>):Promise<T>{if(this.closed)return Promise.reject(new CalendarReminderError('calendar_closed'));const pending=Promise.resolve().then(operation);this.admitted.add(pending);void pending.then(()=>this.admitted.delete(pending),()=>this.admitted.delete(pending));return pending;}
  preview(input:unknown,count=3){this.open();return previewCalendar(input,this.now(),count);}
  private listPage(input:{limit?:number;afterId?:string}={}) {this.open();const limit=input.limit??calendarLimits.page;check(Number.isInteger(limit)&&limit>=1&&limit<=calendarLimits.page);check(input.afterId===undefined||identifier(input.afterId));const b=this.options.binding;const rows=this.db.prepare('SELECT * FROM calendar_series WHERE owner_id=? AND session_id=? AND id>? ORDER BY id LIMIT ?').all(b.ownerId,b.sessionId,input.afterId??'',limit) as unknown as SeriesRow[];return {series:rows.map(s=>this.view(s)),nextCursor:rows.length===limit?rows.at(-1)!.id:null};}
  list(input:{limit?:number;afterId?:string}={}){return this.admit(async()=>{await this.authorized();return this.listPage(input);});}
  findByCreateKey(commandKey:string){return this.admit(async()=>{check(key(commandKey),'calendar_command_key_required');await this.authorized();const b=this.options.binding,id=calendarSeriesId(b,commandKey);const row=this.db.prepare('SELECT * FROM calendar_series WHERE id=? AND owner_id=? AND session_id=?').get(id,b.ownerId,b.sessionId) as unknown as SeriesRow|undefined;return row?this.view(row):null;});}
  history(id:string,limit=20){return this.admit(async()=>{await this.authorized();this.row(id);check(Number.isInteger(limit)&&limit>=1&&limit<=50);return this.db.prepare('SELECT * FROM calendar_occurrences WHERE series_id=? ORDER BY local_date DESC LIMIT ?').all(id,limit).map(raw=>{const o=raw as unknown as OccurrenceRow;return {id:o.id,time:JSON.parse(o.time_json) as CalendarOccurrenceTime,state:o.state,schedule:o.receipt_json?JSON.parse(o.receipt_json) as NativeSchedule:null,errorCode:o.error_code};});});}
  create(input:CalendarCreateInput,admissionGuard?:(context:{existing:boolean})=>void):Promise<CalendarSeriesView>{return this.admit(()=>this.createOnce(input,admissionGuard));}
  private guard(admissionGuard?:()=>void){const result:unknown=admissionGuard?.();if(result!==undefined){if(result&&typeof (result as {then?:unknown}).then==='function')void Promise.resolve(result).catch(()=>undefined);throw new CalendarReminderError('calendar_admission_guard_must_be_synchronous');}}
  private async createOnce(input:CalendarCreateInput,admissionGuard?:(context:{existing:boolean})=>void):Promise<CalendarSeriesView> {
    const raw=record(input);check(key(raw.idempotencyKey),'calendar_command_key_required');const {idempotencyKey,...ruleInput}=raw;const rule=validateCalendarRule(ruleInput);
    await this.authorized();const b=this.options.binding,id=calendarSeriesId(b,idempotencyKey as string),fingerprint=hash(rule);
    this.transaction(()=>{const existing=this.db.prepare('SELECT * FROM calendar_series WHERE id=?').get(id) as unknown as SeriesRow|undefined;this.guard(()=>admissionGuard?.({existing:Boolean(existing)}));if(existing){check(existing.fingerprint===fingerprint,'calendar_command_conflict');return;}check(Number((this.db.prepare('SELECT count(*) AS n FROM calendar_series WHERE owner_id=? AND session_id=?').get(b.ownerId,b.sessionId) as {n:number}).n)<calendarLimits.series,'calendar_series_limit');const now=this.now();this.db.prepare("INSERT INTO calendar_series(id,owner_id,session_id,command_key,fingerprint,rule_json,desired,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',1,?,?)").run(id,b.ownerId,b.sessionId,idempotencyKey as string,fingerprint,JSON.stringify(rule),now,now);});
    return this.enqueue(id,()=>this.sync(id));
  }
  control(id:string,input:CalendarControlInput,admissionGuard?:()=>void):Promise<CalendarSeriesView>{return this.admit(()=>this.controlOnce(id,input,admissionGuard));}
  private async controlOnce(id:string,input:CalendarControlInput,admissionGuard?:()=>void):Promise<CalendarSeriesView> {
    const c=record(input);exact(c,['action','expectedRevision','idempotencyKey']);check(identifier(id)&&typeof c.action==='string'&&['pause','resume','cancel'].includes(c.action)&&Number.isSafeInteger(c.expectedRevision)&&Number(c.expectedRevision)>=1&&key(c.idempotencyKey));
    await this.authorized();
    this.transaction(()=>{this.guard(admissionGuard);const s=this.row(id),fingerprint=hash([input.action,input.expectedRevision]);const old=this.db.prepare('SELECT * FROM calendar_commands WHERE series_id=? AND command_key=?').get(id,input.idempotencyKey) as {fingerprint:string}|undefined;if(old){check(old.fingerprint===fingerprint,'calendar_command_conflict');return;}check(s.revision===input.expectedRevision,'calendar_revision_conflict');check(s.desired!=='cancelled'||input.action==='cancel','calendar_series_cancelled');const revision=s.revision+1;this.db.prepare('INSERT INTO calendar_commands VALUES(?,?,?,?,?,?)').run(`calcmd-${hash([id,input.idempotencyKey])}`,id,input.idempotencyKey,fingerprint,revision,input.action);this.db.prepare('UPDATE calendar_series SET desired=?,revision=?,control_requested=1,error_code=NULL,updated_at=? WHERE id=?').run(input.action==='resume'?'active':input.action==='pause'?'paused':'cancelled',revision,this.now(),id);const o=this.occurrence(s.current_id);if(o){const native=o.receipt_json?JSON.parse(o.receipt_json) as NativeSchedule:null,pending=o.control_json?JSON.parse(o.control_json) as NativeControl:null;const resumeRevision=input.action==='resume'?(native?.status==='paused'?native.revision:pending?.action==='pause'?pending.expectedRevision+1:null):null;this.db.prepare('UPDATE calendar_occurrences SET hold_reason=NULL,error_code=NULL,advance_cancelled=?,resume_revision=? WHERE id=?').run(input.action==='resume'&&native?.status==='cancelled'?1:0,resumeRevision,o.id);}});
    return this.enqueue(id,()=>this.sync(id));
  }
  reconcile(input:{limit?:number;afterId?:string}={}) {return this.admit(async()=>{await this.authorized();const b=this.options.binding;const saved=this.db.prepare('SELECT cursor FROM calendar_reconcile_cursor WHERE owner_id=? AND session_id=?').get(b.ownerId,b.sessionId) as {cursor:string|null}|undefined;const page=this.listPage({...input,afterId:input.afterId??saved?.cursor??undefined});const series:CalendarSeriesView[]=[];for(const s of page.series){try{series.push(await this.enqueue(s.id,()=>this.sync(s.id)));}catch(error){if(this.closed)throw error;this.error(s.id,'calendar_reconciliation_unavailable');series.push(this.view(this.row(s.id)));}await new Promise<void>(resolve=>setImmediate(resolve));}this.open();if(input.afterId===undefined)this.db.prepare('INSERT INTO calendar_reconcile_cursor VALUES(?,?,?) ON CONFLICT(owner_id,session_id) DO UPDATE SET cursor=excluded.cursor').run(b.ownerId,b.sessionId,page.nextCursor);return {series,nextCursor:page.nextCursor};});}
  private error(id:string,code:string|null){this.db.prepare('UPDATE calendar_series SET error_code=?,updated_at=? WHERE id=?').run(code,this.now(),id);}
  private unsettled(s:SeriesRow,o:OccurrenceRow,code:string){this.db.prepare("UPDATE calendar_occurrences SET state='unknown',error_code=? WHERE id=?").run(code,o.id);this.error(s.id,code);}
  private checkReceipt(s:SeriesRow,o:OccurrenceRow,value:NativeSchedule){const rule=JSON.parse(s.rule_json) as CalendarRule,time=JSON.parse(o.time_json) as CalendarOccurrenceTime;check(value&&value.id===o.id&&value.intent===rule.intent&&Number.isSafeInteger(value.revision)&&value.revision>=1&&['queued','paused','dispatched','completed','cancelled'].includes(value.status)&&value.interval_seconds===null&&typeof value.not_before==='string'&&Date.parse(value.not_before)===Date.parse(time.instant)&&Array.isArray(value.dependency_thread_ids)&&value.dependency_thread_ids.length===0&&identifier(value.thread_id)&&value.source_turn_id===`client-schedule-${o.id}`,'calendar_native_schedule_changed');const previous=o.receipt_json?JSON.parse(o.receipt_json) as NativeSchedule:null;if(previous){check(value.revision>=previous.revision&&value.thread_id===previous.thread_id,'calendar_native_schedule_changed');if(value.revision===previous.revision)check(hash([value.status,value.model_alias??null,value.reasoning_effort??null])===hash([previous.status,previous.model_alias??null,previous.reasoning_effort??null]),'calendar_native_schedule_changed');}}
  private receipt(s:SeriesRow,o:OccurrenceRow,value:NativeSchedule){this.checkReceipt(s,o,value);this.db.prepare("UPDATE calendar_occurrences SET attempted=1,state='confirmed',receipt_json=?,error_code=hold_reason WHERE id=?").run(JSON.stringify(value),o.id);this.error(s.id,o.hold_reason);}
  private hold(s:SeriesRow,o:OccurrenceRow,code='calendar_native_control_changed'){this.db.prepare('UPDATE calendar_occurrences SET hold_reason=?,error_code=? WHERE id=?').run(code,code,o.id);this.db.prepare('UPDATE calendar_series SET revision=revision+1,error_code=?,updated_at=? WHERE id=?').run(code,this.now(),s.id);}
  private settleControl(s:SeriesRow){this.db.prepare('UPDATE calendar_series SET control_requested=0,error_code=NULL WHERE id=? AND revision=?').run(s.id,s.revision);}
  private consume(s:SeriesRow,o:OccurrenceRow,skipped=false){this.transaction(()=>{if(skipped)this.db.prepare("UPDATE calendar_occurrences SET state='skipped' WHERE id=?").run(o.id);this.db.prepare('UPDATE calendar_series SET current_id=NULL,error_code=NULL WHERE id=? AND current_id=?').run(s.id,o.id);});}
  private materialize(s:SeriesRow){return this.transaction(()=>{s=this.row(s.id);if(s.current_id||s.desired!=='active'||s.ended)return;const rule=JSON.parse(s.rule_json) as CalendarRule;const time=next(rule,this.now(),s.cursor_date,{remaining:calendarLimits.candidateChecks},[]);if(!time){this.db.prepare('UPDATE calendar_series SET ended=1,control_requested=0 WHERE id=?').run(s.id);return;}const id=`calocc-${hash([s.id,time.localDate])}`;this.db.prepare("INSERT INTO calendar_occurrences(id,series_id,local_date,time_json,state) VALUES(?,?,?,?,'pending')").run(id,s.id,time.localDate,JSON.stringify(time));this.db.prepare('UPDATE calendar_series SET current_id=?,cursor_date=?,error_code=NULL,updated_at=? WHERE id=?').run(id,time.localDate,this.now(),s.id);});}
  private async nativeControl(s:SeriesRow,o:OccurrenceRow,r:NativeSchedule,pending:NativeControl):Promise<boolean>{
    const goal=pending.action==='pause'?'paused':pending.action==='resume'?'queued':'cancelled';
    if(r.revision>pending.expectedRevision){this.db.prepare('UPDATE calendar_occurrences SET control_json=NULL WHERE id=?').run(o.id);if(!pending.attempted||r.revision!==pending.expectedRevision+1||r.status!==goal){this.hold(s,o);return false;}return true;}
    check(r.revision===pending.expectedRevision,'calendar_native_revision_regressed');
    check(pending.action==='pause'?r.status==='queued':pending.action==='resume'?r.status==='paused':['queued','paused'].includes(r.status),'calendar_native_control_changed');
    await this.authorized();
    const current=this.row(s.id),overdue=Date.parse((JSON.parse(o.time_json) as CalendarOccurrenceTime).instant)<=this.now();
    if(!pending.attempted){
      if((pending.action==='resume'&&current.desired==='paused')||(pending.action==='pause'&&current.desired==='active')){this.db.prepare('UPDATE calendar_occurrences SET control_json=NULL WHERE id=?').run(o.id);return true;}
      if(pending.action==='resume'&&(overdue||current.desired==='cancelled')){
        const replacement:NativeControl={...pending,action:'cancel',purpose:overdue&&current.desired==='active'?'resume_overdue':'desired_state'};
        this.db.prepare('UPDATE calendar_occurrences SET control_json=?,advance_cancelled=CASE WHEN ? THEN 1 ELSE advance_cancelled END WHERE id=?').run(JSON.stringify(replacement),replacement.purpose==='resume_overdue'?1:0,o.id);
        return this.nativeControl(current,o,r,replacement);
      }
    }else if(pending.action==='resume'&&(overdue||current.desired!=='active')){this.unsettled(s,o,'calendar_prior_resume_unconfirmed');return false;}
    pending={...pending,attempted:true};
    this.db.prepare('UPDATE calendar_occurrences SET control_json=? WHERE id=?').run(JSON.stringify(pending),o.id);
    try{const result=await this.options.adapter.controlSchedule(this.options.binding.sessionId,o.id,{action:pending.action,expected_revision:pending.expectedRevision});this.checkReceipt(s,o,result);check(result.revision===pending.expectedRevision+1&&result.status===goal,'calendar_native_control_changed');this.receipt(s,o,result);this.db.prepare('UPDATE calendar_occurrences SET control_json=NULL WHERE id=?').run(o.id);return true;}
    catch{this.unsettled(s,o,'calendar_control_unconfirmed');return false;}
  }
  private async changeNative(s:SeriesRow,o:OccurrenceRow,r:NativeSchedule,action:NativeControl['action'],purpose:NativeControl['purpose']='desired_state'){
    const pending:NativeControl={action,expectedRevision:r.revision,seriesRevision:s.revision,purpose,attempted:false};this.db.prepare('UPDATE calendar_occurrences SET control_json=?,advance_cancelled=CASE WHEN ? THEN 1 ELSE advance_cancelled END WHERE id=?').run(JSON.stringify(pending),purpose==='resume_overdue'?1:0,o.id);return this.nativeControl(s,o,r,pending);
  }
  private async sync(id:string):Promise<CalendarSeriesView>{
    // Each pass is bounded; later explicit reconciliations continue pending work.
    for(let step=0;step<4;step++){
      await this.authorized();let s=this.row(id),o=this.occurrence(s.current_id);
      if(!o){if(s.desired!=='active'||s.ended){this.settleControl(s);break;}this.materialize(s);s=this.row(id);o=this.occurrence(s.current_id);if(!o)break;}
      const time=JSON.parse(o.time_json) as CalendarOccurrenceTime;let r:NativeSchedule;
      try{r=await this.options.adapter.getSchedule(this.options.binding.sessionId,o.id);this.checkReceipt(s,o,r);const previous=o.receipt_json?JSON.parse(o.receipt_json) as NativeSchedule:null;const nativeDispatch=previous?.status==='queued'&&['dispatched','completed'].includes(r.status)||previous?.status==='dispatched'&&r.status==='completed';if(previous&&r.revision>previous.revision&&!o.control_json&&!nativeDispatch)this.hold(s,o);this.receipt(s,this.occurrence(o.id)!,r);}
      catch(error){
        if(error instanceof CalendarReminderError){this.error(id,error.code);break;}
        if((error as {status?:number})?.status!==404){this.unsettled(s,o,'calendar_read_unconfirmed');break;}
        s=this.row(id);o=this.occurrence(s.current_id)!;
        if(o.receipt_json){this.unsettled(s,o,'calendar_native_schedule_missing');break;}
        if(o.attempted&&(s.desired!=='active'||Date.parse(time.instant)<=this.now())){this.unsettled(s,o,'calendar_prior_create_unconfirmed');break;}
        if(s.desired!=='active'){if(s.desired==='cancelled')this.consume(s,o,true);this.settleControl(s);break;}
        if(Date.parse(time.instant)<=this.now()){this.consume(s,o,true);continue;}
        await this.authorized();s=this.row(id);o=this.occurrence(s.current_id)!;if(s.desired!=='active')continue;
        if(Date.parse(time.instant)<=this.now()){if(o.attempted){this.unsettled(s,o,'calendar_prior_create_unconfirmed');break;}this.consume(s,o,true);continue;}
        this.db.prepare("UPDATE calendar_occurrences SET attempted=1,state='unknown',error_code='calendar_create_unconfirmed' WHERE id=?").run(o.id);
        const rule=JSON.parse(s.rule_json) as CalendarRule;
        try{r=await this.options.adapter.createSchedule(this.options.binding.sessionId,{id:o.id,intent:rule.intent,not_before:time.instant,dependency_thread_ids:[]});this.receipt(s,o,r);}
        catch{this.unsettled(s,o,'calendar_create_unconfirmed');break;}
      }
      s=this.row(id);o=this.occurrence(s.current_id)!;
      if(o.hold_reason){this.error(id,o.hold_reason);break;}
      if(o.control_json){if(!await this.nativeControl(s,o,r!,JSON.parse(o.control_json)))break;continue;}
      if(s.desired==='cancelled'||s.desired==='paused'){
        if(r!.status==='queued'||(s.desired==='cancelled'&&r!.status==='paused')){if(!s.control_requested){this.hold(s,o);break;}if(!await this.changeNative(s,o,r!,s.desired==='paused'?'pause':'cancel'))break;continue;}
        this.settleControl(s);break;
      }
      if(r!.status==='queued'){this.settleControl(s);break;}
      if(r!.status==='paused'){
        if(!s.control_requested||o.resume_revision!==r!.revision){this.hold(s,o,'calendar_native_paused');break;}
        if(!await this.changeNative(s,o,r!,Date.parse(time.instant)>this.now()?'resume':'cancel',Date.parse(time.instant)>this.now()?'desired_state':'resume_overdue'))break;
        continue;
      }
      if(r!.status==='cancelled'&&!o.advance_cancelled){this.hold(s,o,'calendar_native_cancelled');break;}
      this.consume(s,o,r!.status==='cancelled');
    }
    return this.view(this.row(id));
  }
  close():Promise<void>{if(this.closing)return this.closing;this.closed=true;this.closing=Promise.allSettled([...this.admitted,...this.queues.values()]).then(()=>undefined);return this.closing;}
}
