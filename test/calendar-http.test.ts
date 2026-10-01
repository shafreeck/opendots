import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.ts';
import { RuntimeStore } from '../src/runtime-store.ts';
import { authDigest } from '../src/auth-config.ts';
import type { NativeSchedule } from '../src/reminders.ts';

const rule={intent:'Review the daily plan',timeZone:'America/New_York',frequency:'daily',localTime:'09:00',startDate:'2030-01-01',dst:{gap:'skip',overlap:'earlier'},missed:'skip_unsubmitted',resume:'skip_overdue_paused'};
async function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'opendots-calendar-http-')),dbPath=join(root,'product.db'),authConfigPath=join(root,'auth.json'),baseUrl='http://127.0.0.1:49982',principal='calendar-principal';
  const store=new RuntimeStore(dbPath),binding=store.ensureBinding(baseUrl);const session={id:binding.sessionId,agent_id:binding.agentId,context_id:binding.contextId,status:'active'};store.verifyBinding(session,principal);store.close();
  const credential='a'.repeat(64);writeFileSync(authConfigPath,JSON.stringify({version:1,credential:{kind:'morphz_login_token_sha256',hashHex:authDigest(credential)},sessionTtlSeconds:3600,idleTtlSeconds:600,maximumDevices:8}),{mode:0o600});
  let now=Date.parse('2030-01-01T12:00:00Z'),nativeCalls=0;const native=new Map<string,NativeSchedule>(),creates:any[]=[],controls:any[]=[];
  const hooks:{principal?:()=>Promise<void>;create?:(input:any)=>Promise<void>;loseCreate?:boolean}={};
  const fetcher:typeof fetch=async(url,init)=>{
    nativeCalls++;const path=new URL(String(url)).pathname,method=init?.method??'GET';
    if(path==='/api/session-io/capabilities')return Response.json({enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]});
    if(path===`/api/sessions/${binding.sessionId}`)return Response.json(session);
    if(path.endsWith('/principal')){await hooks.principal?.();return Response.json({principal_id:principal,session_id:binding.sessionId,context_id:binding.contextId});}
    if(path===`/api/sessions/${binding.sessionId}/schedules`&&method==='POST'){
      const input=JSON.parse(String(init?.body));creates.push(input);await hooks.create?.(input);const r:NativeSchedule={...input,revision:1,status:'queued',interval_seconds:null,thread_id:`thread-${input.id}`,source_turn_id:`client-schedule-${input.id}`};native.set(input.id,r);if(hooks.loseCreate){hooks.loseCreate=false;throw Error('fixture lost response');}return Response.json(r);
    }
    const match=path.match(/\/schedules\/(calocc-[a-f0-9]{64})$/);if(match){const r=native.get(match[1]!);if(!r)return Response.json({}, {status:404});if(method==='GET')return Response.json(r);const c=JSON.parse(String(init?.body));controls.push(c);assert.equal(c.expected_revision,r.revision);const next={...r,revision:r.revision+1,status:c.action==='pause'?'paused':c.action==='resume'?'queued':'cancelled'} as NativeSchedule;native.set(r.id,next);return Response.json(next);}
    throw Error('Unexpected fixture path');
  };
  const options={dbPath,baseUrl,authConfigPath,autoStart:false,fetch:fetcher,calendarNow:()=>now};let app=createApplication(options),port=0,origin='',cookie='',csrf='';
  const start=async()=>{await new Promise<void>(r=>app.server.listen(port,'127.0.0.1',r));await app.ready;port=(app.server.address()as any).port;origin=`http://127.0.0.1:${port}`;};await start();
  const login=async()=>{const r=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,connection:'close','content-type':'application/json'},body:JSON.stringify({credential,deviceLabel:'Calendar test'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie')!.split(';')[0]!;csrf=(await r.json()).session.csrfToken;};await login();
  const post=(path:string,input:unknown)=>fetch(origin+path,{method:'POST',headers:{origin,connection:'close',cookie,'x-opendots-csrf':csrf,'content-type':'application/json'},body:JSON.stringify(input)});
  const get=(path:string)=>fetch(origin+path,{headers:{cookie,connection:'close'}});
  const preview=async(value:unknown=rule)=>{const r=await post('/api/calendar-reminders/preview',{rule:value});assert.equal(r.status,200);return r.json();};
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  return {get app(){return app;},get origin(){return origin;},native,creates,controls,hooks,post,get,preview,login,nativeCalls:()=>nativeCalls,tick:(value:string)=>{now=Date.parse(value);},restart:async()=>{await app.close();app=createApplication(options);await start();await login();}};
}
test('calendar preview is explicit, private, pure and creation requires its current confirmation',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.origin+'/api/calendar-reminders',{headers:{connection:'close'}})).status,401);const p=await f.preview();assert.equal(f.nativeCalls(),0);assert.equal(p.occurrences[0].instant,'2030-01-01T14:00:00.000Z');
  assert.equal((await f.post('/api/calendar-reminders',{rule,idempotencyKey:'calendar-http-create',confirmed:false,previewFingerprint:p.previewFingerprint})).status,400);assert.equal(f.nativeCalls(),0);
  const stale=await f.post('/api/calendar-reminders',{rule,idempotencyKey:'calendar-http-create',confirmed:true,previewFingerprint:'stale'});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'calendar_preview_changed');assert.equal(f.creates.length,0);
  const created=await f.post('/api/calendar-reminders',{rule,idempotencyKey:'calendar-http-create',confirmed:true,previewFingerprint:p.previewFingerprint});assert.equal(created.status,202);const view=await created.json();assert.equal(view.occurrence.schedule.not_before,p.occurrences[0].instant);assert.equal(f.creates.length,1);
});
test('unknown HTTP create survives application restart with original key and no new native schedule',async t=>{
  const f=await fixture(t),p=await f.preview();f.hooks.loseCreate=true;const a=await(await f.post('/api/calendar-reminders',{rule,idempotencyKey:'calendar-unknown-key',confirmed:true,previewFingerprint:p.previewFingerprint})).json();assert.equal(a.occurrence.state,'unknown');await f.restart();
  const listed=await(await f.get('/api/calendar-reminders')).json();const row=listed.series[0];assert.equal(row.createCommand.idempotencyKey,'calendar-unknown-key');
  const response=await f.post('/api/calendar-reminders',{rule:row.rule,idempotencyKey:row.createCommand.idempotencyKey,confirmed:true});assert.equal(response.status,202);const retried=await response.json();assert.equal(retried.id,a.id);assert.equal(retried.occurrence.state,'confirmed');assert.equal(f.creates.length,1);
  const paused=await(await f.post(`/api/calendar-reminders/${a.id}/control`,{action:'pause',expectedRevision:retried.revision,idempotencyKey:'calendar-pause-key',confirmed:true})).json();assert.equal(paused.occurrence.schedule.status,'paused');assert.equal(paused.latestControl.idempotencyKey,'calendar-pause-key');
  const history=await(await f.get(`/api/calendar-reminders/${a.id}/occurrences`)).json();assert.equal(history.occurrences[0].id,a.occurrence.id);
});
test('revocation during awaited admission blocks a new calendar intent before commit',async t=>{
  const f=await fixture(t),p=await f.preview();let began!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>{began=r;});let held=false;f.hooks.principal=async()=>{if(!held){held=true;began();await new Promise<void>(r=>{finish=r;});}};
  const creating=f.post('/api/calendar-reminders',{rule,idempotencyKey:'calendar-revoked-key',confirmed:true,previewFingerprint:p.previewFingerprint});await started;assert.equal((await f.post('/api/auth/logout',{})).status,200);finish();assert.equal((await creating).status,401);assert.equal(f.creates.length,0);delete f.hooks.principal;await f.login();assert.equal((await(await f.get('/api/calendar-reminders')).json()).series.length,0);
});
test('already-durable recurrence survives browser logout while private response is withheld',async t=>{
  const f=await fixture(t),p=await f.preview();let began!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>{began=r;});f.hooks.create=async()=>{began();await new Promise<void>(r=>{finish=r;});};
  const creating=f.post('/api/calendar-reminders',{rule,idempotencyKey:'calendar-admitted-key',confirmed:true,previewFingerprint:p.previewFingerprint});await started;assert.equal((await f.post('/api/auth/logout',{})).status,200);finish();assert.equal((await creating).status,401);assert.equal(f.creates.length,1);delete f.hooks.create;await f.login();const row=(await(await f.get('/api/calendar-reminders')).json()).series[0];assert.equal(row.occurrence.state,'confirmed');assert.equal(row.occurrence.schedule.status,'queued');
});
test('BFF reconciliation rotates beyond its first bounded page across restart',async t=>{
  const f=await fixture(t),p=await f.preview();
  for(let i=0;i<51;i++){const response=await f.post('/api/calendar-reminders',{rule,idempotencyKey:`calendar-page-${String(i).padStart(3,'0')}`,confirmed:true,previewFingerprint:p.previewFingerprint});assert.equal(response.status,202);await response.body?.cancel();}
  const page=await(await f.get('/api/calendar-reminders')).json();assert.equal(page.series.length,50);assert.ok(page.nextCursor);const tail=await(await f.post('/api/calendar-reminders/page',{afterId:page.nextCursor})).json();assert.equal(tail.series.length,1);
  const first=await(await f.post('/api/calendar-reminders/reconcile',{})).json();assert.equal(first.series.length,50);await f.restart();const second=await(await f.post('/api/calendar-reminders/reconcile',{})).json();assert.equal(second.series.length,1);assert.ok(!first.series.some((r:any)=>r.id===second.series[0].id));assert.equal(f.creates.length,51);
});
