import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CalendarReminders, CalendarReminderError, previewCalendar, type CalendarRule, type CalendarCreateInput } from '../src/calendar-reminders.ts';
import type { NativeSchedule, ScheduleAdapter } from '../src/reminders.ts';

const rule = (changes:Partial<CalendarRule>={}):CalendarRule => ({intent:'Review the daily plan',timeZone:'UTC',frequency:'daily',localTime:'09:00',startDate:'2030-01-01',dst:{gap:'skip',overlap:'earlier'},missed:'skip_unsubmitted',resume:'skip_overdue_paused',...changes});
const input = (changes:Partial<CalendarCreateInput>={}):CalendarCreateInput => ({...rule(),idempotencyKey:'calendar-create-one',...changes});
const at = Date.parse;
test('daily local time preserves wall clock across spring DST rather than adding 86400 seconds',()=>{
  const p=previewCalendar(rule({timeZone:'America/New_York',startDate:'2026-03-07'}),at('2026-03-07T00:00:00Z'),3);
  assert.deepEqual(p.occurrences.map(x=>x.instant),['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z']);
  assert.deepEqual(p.occurrences.map(x=>x.offset),['-05:00','-04:00','-04:00']);assert.match(p.calculationVersion,/icu=.*;tz=/);
});
test('nonexistent local times skip; overlap chooses exactly the explicitly requested occurrence',()=>{
  const spring=previewCalendar(rule({timeZone:'America/New_York',localTime:'02:30',startDate:'2026-03-08'}),at('2026-03-08T00:00:00Z'),2);
  assert.deepEqual(spring.skippedGaps,['2026-03-08']);assert.equal(spring.occurrences[0]!.instant,'2026-03-09T06:30:00.000Z');
  for(const [overlap,expected]of [['earlier','2026-11-01T05:30:00.000Z'],['later','2026-11-01T06:30:00.000Z']] as const){const p=previewCalendar(rule({timeZone:'America/New_York',localTime:'01:30',startDate:'2026-11-01',dst:{gap:'skip',overlap}}),at('2026-11-01T00:00:00Z'),2);assert.equal(p.occurrences[0]!.instant,expected);assert.equal(p.occurrences[0]!.ambiguous,true);assert.equal(p.occurrences[1]!.localDate,'2026-11-02');}
});
test('Lord Howe half-hour changes and Apia whole skipped date are resolved from actual IANA rules',()=>{
  const early=previewCalendar(rule({timeZone:'Australia/Lord_Howe',localTime:'01:45',startDate:'2026-04-05'}),at('2026-04-04T00:00:00Z'),1);
  const late=previewCalendar(rule({timeZone:'Australia/Lord_Howe',localTime:'01:45',startDate:'2026-04-05',dst:{gap:'skip',overlap:'later'}}),at('2026-04-04T00:00:00Z'),1);
  assert.equal(at(late.occurrences[0]!.instant)-at(early.occurrences[0]!.instant),30*60_000);
  const gap=previewCalendar(rule({timeZone:'Australia/Lord_Howe',localTime:'02:15',startDate:'2026-10-04'}),at('2026-10-03T00:00:00Z'),1);assert.deepEqual(gap.skippedGaps,['2026-10-04']);
  const apia=previewCalendar(rule({timeZone:'Pacific/Apia',startDate:'2011-12-30'}),at('2011-12-29T00:00:00Z'),1);assert.deepEqual(apia.skippedGaps,['2011-12-30']);assert.equal(apia.occurrences[0]!.instant,'2011-12-30T19:00:00.000Z');
});
test('weekly ISO weekdays, inclusive end date, quarter-hour offsets and midnight work',()=>{
  const weekly=previewCalendar(rule({frequency:'weekly',weekdays:[1,3],startDate:'2030-01-01',untilDate:'2030-01-07'}),at('2030-01-01T00:00:00Z'),5);
  assert.deepEqual(weekly.occurrences.map(x=>x.localDate),['2030-01-02','2030-01-07']);assert.equal(weekly.exhausted,true);
  const quarter=previewCalendar(rule({timeZone:'Asia/Kathmandu',localTime:'00:00'}),at('2029-12-31T00:00:00Z'),1);assert.equal(quarter.occurrences[0]!.instant,'2029-12-31T18:15:00.000Z');assert.equal(quarter.occurrences[0]!.offset,'+05:45');
});
test('calendar input is bounded and requires explicit DST/missed/resume policy',()=>{
  for(const r of [rule({startDate:'2030-02-30'}),rule({startDate:'2100-01-01'}),rule({localTime:'24:00'}),rule({timeZone:'+08:00'}),rule({frequency:'weekly',weekdays:[3,1]}),{...rule(),dst:{gap:'forward',overlap:'earlier'}},{...rule(),resume:undefined},{...rule(),intervalSeconds:86400}])assert.throws(()=>previewCalendar(r,at('2030-01-01T00:00:00Z')),CalendarReminderError);
  assert.throws(()=>previewCalendar(rule(),at('2030-01-01T00:00:00Z'),6),CalendarReminderError);
});

function fixture(){
  const db=new DatabaseSync(':memory:'),native=new Map<string,NativeSchedule>(),creates:any[]=[],controls:any[]=[],reads:string[]=[];let now=at('2030-01-01T08:00:00Z'),authCalls=0;
  const hooks:{create?:(value:any)=>Promise<NativeSchedule>;control?:(id:string,command:any)=>Promise<NativeSchedule>;authorize?:()=>Promise<void>}={};
  const materialize=(value:any):NativeSchedule=>({...value,revision:1,status:'queued',interval_seconds:null,thread_id:`thread-${value.id}`,source_turn_id:`client-schedule-${value.id}`});
  const mutate=(id:string,command:any):NativeSchedule=>{const current=native.get(id)!;if(current.revision!==command.expected_revision)throw Object.assign(Error(),{status:409});const changed={...current,revision:current.revision+1,status:command.action==='pause'?'paused':command.action==='resume'?'queued':'cancelled'} as NativeSchedule;native.set(id,changed);return changed;};
  const adapter:ScheduleAdapter={getSchedule:async(_session,id)=>{reads.push(id);const value=native.get(id);if(!value)throw Object.assign(Error(),{status:404});return {...value};},createSchedule:async(_session,value)=>{creates.push(structuredClone(value));if(hooks.create)return hooks.create(value);const previous=native.get(value.id);if(previous)return {...previous};const r=materialize(value);native.set(value.id,r);return {...r};},controlSchedule:async(_session,id,command)=>{controls.push({id,...command});return hooks.control?hooks.control(id,command):mutate(id,command);}};
  const options={db,adapter,binding:{ownerId:'owner',sessionId:'session'},authorize:async()=>{authCalls++;await hooks.authorize?.();},now:()=>now};
  let service=new CalendarReminders(options);
  return {db,native,creates,controls,reads,hooks,materialize,mutate,get service(){return service;},authCalls:()=>authCalls,tick:(instant:string)=>{now=at(instant);},reopen:async()=>{await service.close();service=new CalendarReminders(options);},close:async()=>{await service.close();db.close();}};
}
test('series materializes one exact native one-shot; retries and reopen reuse identity and saved UTC',async()=>{
  const f=fixture();try{const a=await f.service.create(input()),b=await f.service.create(input());assert.equal(a.id,b.id);assert.equal(f.creates.length,1);assert.equal(f.creates[0].not_before,'2030-01-01T09:00:00.000Z');assert.equal(f.creates[0].interval_seconds,undefined);assert.deepEqual(f.creates[0].dependency_thread_ids,[]);
    const original=a.occurrence!.time;await f.reopen();const c=(await f.service.reconcile()).series[0]!;assert.deepEqual(c.occurrence!.time,original);assert.equal(f.creates.length,1);assert.equal(c.occurrence!.schedule!.source_turn_id,`client-schedule-${c.occurrence!.id}`);
    await assert.rejects(f.service.create(input({intent:'changed'})),CalendarReminderError);
  }finally{await f.close();}
});
test('lost create receipt is read back by stable native schedule ID without resending',async()=>{
  const f=fixture();try{f.hooks.create=async value=>{f.native.set(value.id,f.materialize(value));throw Error('SYNTHETIC_SECRET_ERROR');};const a=await f.service.create(input());assert.equal(a.occurrence!.state,'unknown');assert.ok(!JSON.stringify(a).includes('SECRET'));delete f.hooks.create;await f.reopen();const r=(await f.service.reconcile()).series[0]!;assert.equal(r.occurrence!.state,'confirmed');assert.equal(f.creates.length,1);}finally{await f.close();}
});
test('unknown create + pause/cancel + 404 preserves uncertainty until delayed native receipt appears',async()=>{
  for(const action of ['pause','cancel']as const){const f=fixture();try{let release!:()=>void,began!:()=>void;const started=new Promise<void>(r=>{began=r;});f.hooks.create=async()=>{began();await new Promise<void>(r=>{release=r;});throw Error('lost before receipt');};
    const creating=f.service.create(input());await started;const current=(await f.service.list()).series[0]!;const controlling=f.service.control(current.id,{action,expectedRevision:current.revision,idempotencyKey:`command-${action}`});await new Promise(setImmediate);release();await creating;const pending=await controlling;assert.equal(pending.desiredState,action==='pause'?'paused':'cancelled');assert.equal(pending.controlPending,true);assert.equal(pending.recoveryDecisionRequired,false);assert.equal(pending.errorCode,'calendar_prior_create_unconfirmed');assert.equal(f.creates.length,1);assert.equal(f.controls.length,0);
    await f.reopen();await f.service.reconcile();assert.equal(f.creates.length,1);assert.equal(f.controls.length,0);const payload=f.creates[0];f.native.set(payload.id,f.materialize(payload));delete f.hooks.create;const settled=(await f.service.reconcile()).series[0]!;assert.equal(settled.controlPending,false);assert.equal(settled.occurrence!.schedule!.status,action==='pause'?'paused':'cancelled');assert.equal(f.controls.length,1);
  }finally{await f.close();}}
});
test('pause admitted during an in-flight successful create is applied after receipt without duplicate create',async()=>{
  const f=fixture();try{let release!:()=>void,began!:()=>void;const started=new Promise<void>(r=>{began=r;});f.hooks.create=async value=>{began();await new Promise<void>(r=>{release=r;});const r=f.materialize(value);f.native.set(value.id,r);return r;};const creating=f.service.create(input());await started;const a=(await f.service.list()).series[0]!;const pausing=f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-race-1'});await new Promise(setImmediate);release();await creating;const result=await pausing;assert.equal(result.occurrence!.schedule!.status,'paused');assert.equal(f.creates.length,1);assert.deepEqual(f.controls.map(c=>c.action),['pause']);}finally{await f.close();}
});
test('after authorization crosses due time, never-submitted occurrence is skipped before native POST',async()=>{
  const f=fixture();try{f.hooks.authorize=async()=>{if(f.authCalls()===3)f.tick('2030-01-01T09:01:00Z');};const r=await f.service.create(input());assert.equal(f.creates.length,1);assert.equal(f.creates[0].not_before,'2030-01-02T09:00:00.000Z');assert.equal(r.occurrence!.time.localDate,'2030-01-02');assert.ok((await f.service.history(r.id)).some(o=>o.state==='skipped'&&o.time.localDate==='2030-01-01'));}finally{await f.close();}
});
test('overdue unknown create and confirmed-then-missing schedule are never recreated',async()=>{
  const f=fixture();try{f.hooks.create=async()=>{throw Error('unknown');};const a=await f.service.create(input());f.tick('2030-01-02T12:00:00Z');const r=(await f.service.reconcile()).series[0]!;assert.equal(r.errorCode,'calendar_prior_create_unconfirmed');assert.equal(f.creates.length,1);assert.equal(r.occurrence!.id,a.occurrence!.id);}finally{await f.close();}
  const g=fixture();try{const a=await g.service.create(input());g.native.clear();const r=(await g.service.reconcile()).series[0]!;assert.equal(r.errorCode,'calendar_native_schedule_missing');assert.equal(g.creates.length,1);assert.equal(r.occurrence!.id,a.occurrence!.id);}finally{await g.close();}
});
test('dispatched work stays native-owned and does not block the next day; downtime never backfills',async()=>{
  const f=fixture();try{const a=await f.service.create(input()),r=f.native.get(a.occurrence!.id)!;f.native.set(r.id,{...r,revision:2,status:'dispatched'});f.tick('2030-01-04T12:00:00Z');const next=(await f.service.reconcile()).series[0]!;assert.equal(next.occurrence!.time.localDate,'2030-01-05');assert.equal(f.creates.length,2);assert.equal(f.controls.length,0);assert.equal(f.native.get(r.id)!.status,'dispatched');assert.equal(next.alreadyDispatchedWork,'native_owned');}finally{await f.close();}
});
test('explicit resume preserves future occurrence, but cancels/skips overdue paused occurrence',async()=>{
  for(const overdue of [false,true]){const f=fixture();try{const a=await f.service.create(input()),paused=await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-command'});if(overdue)f.tick('2030-01-02T10:00:00Z');const resumed=await f.service.control(a.id,{action:'resume',expectedRevision:paused.revision,idempotencyKey:'resume-command'});assert.equal(resumed.desiredState,'active');assert.equal(resumed.occurrence!.time.localDate,overdue?'2030-01-03':'2030-01-01');assert.deepEqual(f.controls.map(c=>c.action),overdue?['pause','cancel']:['pause','resume']);assert.equal(f.creates.length,overdue?2:1);}finally{await f.close();}}
});
test('unknown native control is fenced with its saved CAS revision before newer resume',async()=>{
  const f=fixture();try{const a=await f.service.create(input());f.hooks.control=async()=>{throw Error('before receipt');};const paused=await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});assert.equal(paused.controlPending,true);delete f.hooks.control;await f.reopen();const resumed=await f.service.control(a.id,{action:'resume',expectedRevision:paused.revision,idempotencyKey:'resume-control'});assert.equal(resumed.occurrence!.schedule!.status,'queued');assert.deepEqual(f.controls.map(c=>[c.action,c.expected_revision]),[['pause',1],['pause',1],['resume',2]]);assert.equal(f.creates.length,1);}finally{await f.close();}
});
test('control receipt lost after native commit is reconciled without another mutation',async()=>{
  const f=fixture();try{const a=await f.service.create(input());f.hooks.control=async(id,c)=>{f.mutate(id,c);throw Error('lost response');};await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});delete f.hooks.control;await f.reopen();const r=(await f.service.reconcile()).series[0]!;assert.equal(r.occurrence!.schedule!.status,'paused');assert.equal(r.controlPending,false);assert.equal(f.controls.length,1);}finally{await f.close();}
});
test('resume becoming overdue during authorization replans only an unattempted CAS to cancel',async()=>{
  const f=fixture();try{const a=await f.service.create(input()),paused=await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});const baseline=f.authCalls();f.hooks.authorize=async()=>{if(f.authCalls()===baseline+3)f.tick('2030-01-01T09:01:00Z');};const resumed=await f.service.control(a.id,{action:'resume',expectedRevision:paused.revision,idempotencyKey:'resume-control'});assert.deepEqual(f.controls.map(c=>c.action),['pause','cancel']);assert.equal(resumed.occurrence!.time.localDate,'2030-01-02');}finally{await f.close();}
});
test('already-attempted unknown resume is never rewritten or repeated after its due time',async()=>{
  const f=fixture();try{const a=await f.service.create(input()),paused=await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});f.hooks.control=async()=>{throw Error('unknown resume');};await f.service.control(a.id,{action:'resume',expectedRevision:paused.revision,idempotencyKey:'resume-control'});delete f.hooks.control;f.tick('2030-01-01T09:01:00Z');await f.reopen();const held=(await f.service.reconcile()).series[0]!;assert.equal(held.errorCode,'calendar_prior_resume_unconfirmed');assert.deepEqual(f.controls.map(c=>c.action),['pause','resume']);assert.equal(f.creates.length,1);}finally{await f.close();}
});
test('newer pause/cancel never replays an already-unknown resume while its due time is still future',async()=>{
  for(const action of ['pause','cancel']as const){const f=fixture();try{const a=await f.service.create(input()),paused=await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});f.hooks.control=async()=>{throw Error('unknown resume');};const unknown=await f.service.control(a.id,{action:'resume',expectedRevision:paused.revision,idempotencyKey:'resume-control'});delete f.hooks.control;const stopped=await f.service.control(a.id,{action,expectedRevision:unknown.revision,idempotencyKey:`new-stop-${action}`});assert.equal(stopped.errorCode,'calendar_prior_resume_unconfirmed');assert.equal(stopped.controlPending,true);assert.deepEqual(f.controls.map(c=>c.action),['pause','resume']);assert.equal(f.creates.length,1);}finally{await f.close();}}
});
test('synchronous admission guard is checked before durable writes and not inherited by admitted reconciliation',async()=>{
  const f=fixture();try{await assert.rejects(f.service.create(input(),()=>{throw Error('revoked');}));assert.equal((await f.service.list()).series.length,0);assert.equal(f.creates.length,0);
    await assert.rejects(f.service.create(input(),async()=>undefined),e=>e instanceof CalendarReminderError&&e.code==='calendar_admission_guard_must_be_synchronous');assert.equal((await f.service.list()).series.length,0);
    let allowed=true;f.hooks.create=async value=>{allowed=false;const native=f.materialize(value);f.native.set(value.id,native);return native;};const a=await f.service.create(input(),()=>{assert.equal(allowed,true);});assert.equal(a.occurrence!.state,'confirmed');assert.equal(f.creates.length,1);assert.equal(a.createCommand.idempotencyKey,input().idempotencyKey);
    await assert.rejects(f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'denied-control'},()=>{throw Error('revoked');}));assert.equal(f.controls.length,0);
  }finally{await f.close();}
});
test('external resume after confirmed pause is held, not silently paused again',async()=>{
  const f=fixture();try{const a=await f.service.create(input()),paused=await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});const r=f.native.get(a.occurrence!.id)!;f.native.set(r.id,{...r,revision:3,status:'queued'});const held=(await f.service.reconcile()).series[0]!;assert.equal(held.errorCode,'calendar_native_control_changed');assert.equal(held.recoveryDecisionRequired,true);assert.equal(f.controls.length,1);assert.ok(held.revision>paused.revision);await f.service.reconcile();assert.equal(f.controls.length,1);const confirmed=await f.service.control(a.id,{action:'pause',expectedRevision:held.revision,idempotencyKey:'explicit-new-pause'});assert.equal(confirmed.occurrence!.schedule!.status,'paused');assert.equal(f.controls[1].expected_revision,3);}finally{await f.close();}
});
test('out-of-band cancellation or mismatched higher CAS revision cannot consume a successor',async()=>{
  const f=fixture();try{const a=await f.service.create(input());f.hooks.control=async()=>{throw Error('unknown');};await f.service.control(a.id,{action:'pause',expectedRevision:a.revision,idempotencyKey:'pause-control'});delete f.hooks.control;const r=f.native.get(a.occurrence!.id)!;f.native.set(r.id,{...r,revision:2,status:'cancelled'});const held=(await f.service.reconcile()).series[0]!;assert.equal(held.errorCode,'calendar_native_control_changed');assert.equal(f.creates.length,1);assert.equal(f.controls.length,1);}finally{await f.close();}
  const g=fixture();try{const a=await g.service.create(input()),r=g.native.get(a.occurrence!.id)!;g.native.set(r.id,{...r,revision:2,status:'cancelled'});await g.service.reconcile();await g.service.reconcile();assert.equal(g.creates.length,1);assert.equal(g.controls.length,0);}finally{await g.close();}
});
test('foreign source identity, same-revision changes and external timing/dependencies halt safely',async()=>{
  const changes=[{source_turn_id:'foreign-root'},{status:'paused'},{revision:2,not_before:'2030-01-02T09:00:00.000Z'},{revision:2,interval_seconds:86400},{revision:2,dependency_thread_ids:['foreign-thread']}];
  for(const change of changes){const f=fixture();try{const a=await f.service.create(input()),r=f.native.get(a.occurrence!.id)!;f.native.set(r.id,{...r,...change} as NativeSchedule);const held=(await f.service.reconcile()).series[0]!;assert.equal(held.errorCode,'calendar_native_schedule_changed');assert.equal(f.creates.length,1);assert.equal(f.controls.length,0);}finally{await f.close();}}
});
test('control keys/revisions are durable and cancelled series cannot resume',async()=>{
  const f=fixture();try{const a=await f.service.create(input()),c={action:'cancel' as const,expectedRevision:a.revision,idempotencyKey:'cancel-command'};const cancelled=await f.service.control(a.id,c);const retry=await f.service.control(a.id,c);assert.equal(retry.revision,cancelled.revision);assert.equal(f.controls.length,1);await assert.rejects(f.service.control(a.id,{...c,action:'pause'}),CalendarReminderError);await assert.rejects(f.service.control(a.id,{action:'resume',expectedRevision:cancelled.revision,idempotencyKey:'cannot-resume'}),CalendarReminderError);}finally{await f.close();}
});
test('list/history reauthorize, reconciliation rotates its cursor and yields between series',async()=>{
  const f=fixture();try{for(let i=0;i<3;i++)await f.service.create(input({idempotencyKey:`calendar-series-${i}`}));const a=await f.service.reconcile({limit:1}),b=await f.service.reconcile({limit:1});assert.notEqual(a.series[0]!.id,b.series[0]!.id);await f.reopen();const c=await f.service.reconcile({limit:1});assert.notEqual(c.series[0]!.id,a.series[0]!.id);assert.notEqual(c.series[0]!.id,b.series[0]!.id);f.hooks.authorize=async()=>{throw Error('revoked');};await assert.rejects(f.service.list(),CalendarReminderError);await assert.rejects(f.service.history(a.series[0]!.id),CalendarReminderError);}finally{await f.close();}
});
