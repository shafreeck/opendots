/** Optional actual Runtime lifecycle: future one-shots only, no due trigger,
 * model request, exec, desktop, external provider or direct native database writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { createHash,randomBytes } from 'node:crypto';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.ts';

test('unchanged official Runtime stores future calendar UTC and survives BFF restart/control', {skip:!process.env.OPENDOTS_RUNTIME_BINARY,timeout:45_000},async()=>{
  const binary=resolve(process.env.OPENDOTS_RUNTIME_BINARY!);assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),'29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3');
  const root=mkdtempSync(join(tmpdir(),'opendots-calendar-native-'));mkdirSync(join(root,'workspace'),{mode:0o700});let providerCalls=0;
  const provider=createServer((_request,response)=>{providerCalls++;response.writeHead(500);response.end('No model call allowed in this fixture');});
  const listen=(s:ReturnType<typeof createServer>)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address()as any).port)));
  const providerPort=await listen(provider),probe=createServer(),runtimePort=await listen(probe);await new Promise<void>(r=>probe.close(()=>r()));
  const origin=`http://127.0.0.1:${runtimePort}`,token=randomBytes(32).toString('hex'),config=join(root,'runtime.toml'),dbPath=join(root,'product.db');let child:ChildProcess|undefined,app:ReturnType<typeof createApplication>|undefined,productOrigin='',csrf='';
  writeFileSync(config,`[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(join(root,'workspace'))}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root,'artifacts'))}\n`,{mode:0o600});
  async function native(path:string,input?:unknown){const r=await fetch(origin+path,{method:input===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',connection:'close'},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(3_000),redirect:'error'});assert.ok(r.ok,`Native HTTP ${r.status}`);return r.json()as Promise<any>;}
  async function product(path:string,input?:unknown){const r=await fetch(productOrigin+path,{method:input===undefined?'GET':'POST',headers:{origin:productOrigin,'content-type':'application/json',connection:'close','x-opendots-csrf':csrf},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(10_000),redirect:'error'});assert.ok(r.ok,`Product HTTP ${r.status}`);return r.json()as Promise<any>;}
  async function openApp(){app=createApplication({dbPath,baseUrl:origin,operatorToken:token,autoStart:false,streamEnabled:false});await new Promise<void>(r=>app!.server.listen(0,'127.0.0.1',r));await app.ready;productOrigin=`http://127.0.0.1:${(app.server.address()as any).port}`;csrf=(await product('/api/state')).csrfToken;}
  try{
    child=spawn(binary,['serve','--bind',`127.0.0.1:${runtimePort}`,'--cwd',root,'--config-file',config,'--log-level','warn'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,USERPROFILE:root,MORPHZ_HOME:join(root,'home'),MORPHZ_DASHBOARD_TOKEN:token,MORPHZ_PRINCIPAL_ID:'calendar-native-fixture',MORPHZ_STORAGE_SQLITE_PATH:join(root,'runtime.db'),LANG:'C.UTF-8'},stdio:'ignore'});
    const until=Date.now()+15_000;for(;;){assert.equal(child.exitCode,null);try{if((await native('/api/session-io/capabilities')).enabled)break;}catch{}if(Date.now()>until)throw Error('Fixture Runtime startup timeout');await new Promise(r=>setTimeout(r,50));}
    await openApp();
    const daily={intent:'Future calendar lifecycle fixture',timeZone:'Asia/Shanghai',frequency:'daily',localTime:'09:30',startDate:'2030-01-01',untilDate:'2030-01-15',dst:{gap:'skip',overlap:'earlier'},missed:'skip_unsubmitted',resume:'skip_overdue_paused'};
    const views:any[]=[];
    for(const [index,rule]of [daily,{...daily,frequency:'weekly',weekdays:[2]}].entries()){
      const preview=await product('/api/calendar-reminders/preview',{rule});const created=await product('/api/calendar-reminders',{rule,idempotencyKey:`native-calendar-${index}`,confirmed:true,previewFingerprint:preview.previewFingerprint});
      const binding=app!.runtime!.store.binding()!,receipt=await native(`/api/sessions/${binding.sessionId}/schedules/${created.occurrence.id}`);
      assert.equal(new Date(receipt.not_before).toISOString(),created.occurrence.time.instant);assert.equal(receipt.interval_seconds,null);assert.equal(receipt.status,'queued');assert.equal(receipt.source_turn_id,`client-schedule-${created.occurrence.id}`);
      const paused=await product(`/api/calendar-reminders/${created.id}/control`,{action:'pause',expectedRevision:created.revision,idempotencyKey:`native-pause-${index}`,confirmed:true});assert.equal(paused.occurrence.schedule.status,'paused');
      const resumed=await product(`/api/calendar-reminders/${created.id}/control`,{action:'resume',expectedRevision:paused.revision,idempotencyKey:`native-resume-${index}`,confirmed:true});assert.equal(resumed.occurrence.schedule.status,'queued');views.push(resumed);
    }
    await app!.close();app=undefined;await openApp();const after=await product('/api/calendar-reminders');assert.equal(after.series.length,2);
    for(const prior of views){const saved=after.series.find((s:any)=>s.id===prior.id);assert.equal(saved.occurrence.id,prior.occurrence.id);assert.equal(saved.occurrence.time.instant,prior.occurrence.time.instant);const retried=await product('/api/calendar-reminders',{rule:saved.rule,idempotencyKey:saved.createCommand.idempotencyKey,confirmed:true});assert.equal(retried.occurrence.id,prior.occurrence.id);const cancelled=await product(`/api/calendar-reminders/${saved.id}/control`,{action:'cancel',expectedRevision:retried.revision,idempotencyKey:`cancel-${saved.id}`,confirmed:true});assert.equal(cancelled.occurrence.schedule.status,'cancelled');}
    assert.equal(providerCalls,0);console.log(JSON.stringify({level:'L2',runtime:'unchanged official v0.1.3',series:2,frequencies:['daily','weekly'],exactUtcVerified:true,restartSameScheduleIds:true,pauseResumeCancel:true,dueTriggers:0,modelCalls:providerCalls,paidCalls:0}));
  }finally{
    await app?.close();if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise<void>(r=>{const timer=setTimeout(()=>child!.kill('SIGKILL'),2_000);child!.once('close',()=>{clearTimeout(timer);r();});});}
    provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});
  }
});
