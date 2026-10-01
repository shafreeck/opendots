import test from 'node:test';
import { createServer } from 'node:http';
import { HOST_CALENDAR_PATH, HOST_CONNECTOR_PATH } from '../src/host-tools-listener.ts';
import { ConnectorError } from '../src/connector-types.ts';
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
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const callbackPort=(probe.address()as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  const hostToolsConfigPath=join(root,'host-tools.json'),callbackToken='c'.repeat(64),githubToken='d'.repeat(64);
  const config={version:2,ownerId:binding.userId,runtimeOrigin:baseUrl,binding:{principalId:principal,agentId:binding.agentId,contextId:binding.contextId,sessionId:binding.sessionId},callbackPort,tools:{calendarProposals:{callbackToken,allowProposals:true},githubPublic:{callbackToken:githubToken,allowPublicGithubReads:true,repositories:['morphz-ai/morphz']}}};writeFileSync(hostToolsConfigPath,JSON.stringify(config),{mode:0o600});
  const jobs=new Map<string,any>();let githubCalls=0;
  let now=Date.parse('2030-01-01T12:00:00Z'),nativeCalls=0;const native=new Map<string,NativeSchedule>(),creates:any[]=[],controls:any[]=[];
  const hooks:{principal?:()=>Promise<void>;create?:(input:any)=>Promise<void>;loseCreate?:boolean}={};
  const fetcher:typeof fetch=async(url,init)=>{
    nativeCalls++;const path=new URL(String(url)).pathname,method=init?.method??'GET';
    if(path.startsWith('/api/execution-jobs/')){const job=jobs.get(path.split('/').at(-1)!);return job?Response.json(job):Response.json({}, {status:404});}
    if(path.includes('/threads/'))return Response.json({snapshot:{thread:{id:'fixture-thread',target_id:'target-default',agent_id:binding.agentId,context_id:binding.contextId,session_id:binding.sessionId,initiating_principal_id:principal,lifecycle:'open',control_state:'active'}}});
    if(path==='/api/execution-targets')return Response.json({targets:[{id:'target-default',revision:1,kind:'in_process_local',status:'online',capabilities:[CALENDAR_TOOL]}]});
    if(path==='/api/session-io/capabilities')return Response.json({enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]});
    if(path===`/api/sessions/${binding.sessionId}`)return Response.json(session);
    if(path.endsWith('/principal')){await hooks.principal?.();return Response.json({principal_id:principal,session_id:binding.sessionId,context_id:binding.contextId});}
    if(path===`/api/sessions/${binding.sessionId}/schedules`&&method==='POST'){
      const input=JSON.parse(String(init?.body));creates.push(input);await hooks.create?.(input);const r:NativeSchedule={...input,revision:1,status:'queued',interval_seconds:null,thread_id:`thread-${input.id}`,source_turn_id:`client-schedule-${input.id}`};native.set(input.id,r);if(hooks.loseCreate){hooks.loseCreate=false;throw Error('fixture lost response');}return Response.json(r);
    }
    const match=path.match(/\/schedules\/(calocc-[a-f0-9]{64})$/);if(match){const r=native.get(match[1]!);if(!r)return Response.json({}, {status:404});if(method==='GET')return Response.json(r);const c=JSON.parse(String(init?.body));controls.push(c);assert.equal(c.expected_revision,r.revision);const next={...r,revision:r.revision+1,status:c.action==='pause'?'paused':c.action==='resume'?'queued':'cancelled'} as NativeSchedule;native.set(r.id,next);return Response.json(next);}
    throw Error('Unexpected fixture path');
  };
  const options={dbPath,baseUrl,authConfigPath,hostToolsConfigPath,autoStart:false,fetch:fetcher,calendarNow:()=>now,connectorGithubFetch:async()=>{githubCalls++;throw Error('No GitHub call expected');}};let app=createApplication(options),port=0,origin='',cookie='',csrf='';
  const start=async()=>{await new Promise<void>(r=>app.server.listen(port,'127.0.0.1',r));await app.ready;await app.hostTools!.start();port=(app.server.address()as any).port;origin=`http://127.0.0.1:${port}`;};await start();
  const login=async()=>{const r=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,connection:'close','content-type':'application/json'},body:JSON.stringify({credential,deviceLabel:'Calendar test'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie')!.split(';')[0]!;csrf=(await r.json()).session.csrfToken;};await login();
  const post=(path:string,input:unknown)=>fetch(origin+path,{method:'POST',headers:{origin,connection:'close',cookie,'x-opendots-csrf':csrf,'content-type':'application/json'},body:JSON.stringify(input)});
  const get=(path:string)=>fetch(origin+path,{headers:{cookie,connection:'close'}});
  const preview=async(value:unknown=rule)=>{const r=await post('/api/calendar-reminders/preview',{rule:value});assert.equal(r.status,200);return r.json();};
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  const envelope=(args:unknown,call='call')=>{const invocation={job_id:`fixture-job-${call}`,tool_call_id:call,principal_id:principal,agent_id:binding.agentId,context_id:binding.contextId,session_id:binding.sessionId,thread_id:'fixture-thread',target_id:'target-default'};jobs.set(invocation.job_id,{id:invocation.job_id,...invocation,initiating_principal_id:principal,tool_name:CALENDAR_TOOL,request:{...(args as object),_morphz_execution_route:{target_id:'target-default',backend_kind:'in_process_local'},_morphz_wake_thread:false},status:'running',cancel_requested_at:null});return{protocol:1,tool:CALENDAR_TOOL,invocation,arguments:args};};
  const callback=(body:unknown,headers:Record<string,string>={},path=HOST_CALENDAR_PATH)=>fetch(`http://127.0.0.1:${callbackPort}`+path,{method:'POST',headers:{connection:'close','content-type':'application/json',authorization:`Bearer ${callbackToken}`,...headers},body:JSON.stringify(body)});
  return {envelope,callback,jobs,callbackToken,githubToken,githubCalls:()=>githubCalls,options,config,hostToolsConfigPath,get cookie(){return cookie;},get app(){return app;},get origin(){return origin;},native,creates,controls,hooks,post,get,preview,login,nativeCalls:()=>nativeCalls,tick:(value:string)=>{now=Date.parse(value);},restart:async()=>{await app.close();app=createApplication(options);await start();await login();}};
}

import {CALENDAR_TOOL} from '../src/calendar-proposals.ts';
async function seed(f:any,call='call'){const e=f.envelope({action:'propose',rule},call);const response=await f.callback(e);assert.equal(response.status,200);const result=await response.json();f.jobs.get(e.invocation.job_id).status='succeeded';return result.proposal;}
async function payload(f:any,p:any){const r=await f.post(`/api/calendar-proposals/${p.proposalId}/preview`,{expectedRevision:p.revision});assert.equal(r.status,200);const a=await r.json();return{expectedRevision:p.revision,ruleFingerprint:p.ruleFingerprint,previewFingerprint:a.previewFingerprint,confirmed:true};}
test('proposal is private, no native create before explicit confirmation, unknown retains exact receipt across restart',async t=>{const f=await fixture(t),p=await seed(f),body=await payload(f,p);assert.equal((await fetch(f.origin+'/api/calendar-proposals',{headers:{connection:'close'}})).status,401);assert.equal(f.creates.length,0);f.hooks.loseCreate=true;const r=await f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);assert.equal(r.status,200);const a=await r.json();assert.equal(a.proposal.state,'admitted');assert.equal(a.series.occurrence.state,'unknown');assert.equal(a.series.occurrence.schedule,null);await f.restart();const status=await(await f.get(`/api/calendar-proposals/${p.proposalId}`)).json();assert.equal(status.proposal.state,'admitted');const b=await f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,{...body,previewFingerprint:undefined});assert.equal(b.status,200);const result=await b.json();assert.equal(result.series.id,a.series.id);assert.equal(f.creates.length,1);assert.equal(result.series.occurrence.state,'confirmed');});
test('concurrent dismiss wins while confirmation awaits native identity; no series or proposal resurrection',async t=>{const f=await fixture(t),p=await seed(f),body=await payload(f,p);let began!:()=>void,release!:()=>void,once=false;const started=new Promise<void>(r=>began=r);f.hooks.principal=async()=>{if(!once){once=true;began();await new Promise<void>(r=>release=r)}};const confirming=f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);await started;const dismissed=await f.post(`/api/calendar-proposals/${p.proposalId}/dismiss`,{expectedRevision:p.revision});assert.equal(dismissed.status,200);release();assert.equal((await confirming).status,409);delete f.hooks.principal;assert.equal(f.creates.length,0);assert.equal((await(await f.get(`/api/calendar-proposals/${p.proposalId}`)).json()).proposal.state,'dismissed');assert.equal((await(await f.get('/api/calendar-reminders')).json()).series.length,0);});
test('owner revoked at detached authorization before proposal and series CAS leaves both untouched',async t=>{const f=await fixture(t),p=await seed(f),body=await payload(f,p);let began!:()=>void,release!:()=>void,n=0;const started=new Promise<void>(r=>began=r);f.hooks.principal=async()=>{if(++n===3){began();await new Promise<void>(r=>release=r)}};const confirming=f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);await started;assert.equal((await f.post('/api/auth/logout',{})).status,200);release();assert.equal((await confirming).status,401);delete f.hooks.principal;await f.login();assert.equal(f.creates.length,0);assert.equal((await(await f.get(`/api/calendar-proposals/${p.proposalId}`)).json()).proposal.state,'pending_owner_confirmation');assert.equal((await(await f.get('/api/calendar-reminders')).json()).series.length,0);});
test('duplicate confirmation and late dismissal cannot make a second series or undo an admitted intent',async t=>{const f=await fixture(t),p=await seed(f),body=await payload(f,p);let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r);f.hooks.create=async()=>{began();await new Promise<void>(r=>release=r)};const first=f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);await started;const duplicate=f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);const dismissed=await f.post(`/api/calendar-proposals/${p.proposalId}/dismiss`,{expectedRevision:1});assert.equal(dismissed.status,409);assert.equal((await dismissed.json()).code,'calendar_proposal_already_admitted');release();assert.equal((await first).status,200);assert.equal((await duplicate).status,200);assert.equal(f.creates.length,1);});
test('stale preview before first admission changes neither proposal nor schedule',async t=>{const f=await fixture(t),p=await seed(f),body=await payload(f,p);f.tick('2030-01-02T16:00:00Z');const r=await f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);assert.equal(r.status,409);assert.equal((await r.json()).code,'calendar_preview_changed');assert.equal(f.creates.length,0);assert.equal((await(await f.get(`/api/calendar-proposals/${p.proposalId}`)).json()).proposal.state,'pending_owner_confirmation');});
test('shared listener pins path/token/tool and a model can neither approve nor bypass owner authentication',async t=>{
  const f=await fixture(t),e=f.envelope({action:'propose',rule});
  assert.equal((await f.callback(e,{authorization:`Bearer ${f.githubToken}`})).status,401);
  assert.equal((await f.callback(e,{},HOST_CONNECTOR_PATH)).status,401);
  assert.equal((await f.callback(e,{cookie:f.cookie})).status,403);
  for(const args of [{action:'confirm',rule},{action:'propose',rule,confirmed:true},{action:'propose',rule,ownerId:'injected'}])assert.equal((await f.callback(f.envelope(args,'forged'))).status,400);
  const valid=await f.callback(e);assert.equal(valid.status,200);const p=(await valid.json()).proposal;
  const nativeBearer=await fetch(f.origin+`/api/calendar-proposals/${p.proposalId}/confirm`,{method:'POST',headers:{origin:f.origin,authorization:`Bearer ${f.callbackToken}`,connection:'close','content-type':'application/json'},body:JSON.stringify({expectedRevision:1,ruleFingerprint:p.ruleFingerprint,confirmed:true})});assert.equal(nativeBearer.status,401);
  const wrongProof=f.envelope({action:'propose',rule},'wrong-proof');f.jobs.get(wrongProof.invocation.job_id).tool_name='host_opendots_connectors';assert.equal((await f.callback(wrongProof)).status,403);
  assert.equal(f.creates.length,0);assert.equal(f.githubCalls(),0);const list=await(await f.get('/api/calendar-proposals')).json();assert.equal(list.pendingCount,1);assert.equal(list.proposals.length,1);
});
test('old native Call preserves pending receipt after owner admission while a new status Call observes actual series',async t=>{
  const f=await fixture(t),e=f.envelope({action:'propose',rule}),first=await(await f.callback(e)).json(),p=first.proposal,body=await payload(f,p);
  const admitted=await(await f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body)).json();assert.equal(admitted.series.occurrence.schedule.status,'queued');f.jobs.get(e.invocation.job_id).status='succeeded';
  assert.deepEqual(await(await f.callback(e)).json(),first);const current=await(await f.callback(f.envelope({action:'status',proposalId:p.proposalId},'status'))).json();assert.equal(current.proposal.state,'admitted');assert.equal(current.series.id,admitted.series.id);assert.equal(current.series.occurrence.schedule.status,'queued');
  const changed={...e,arguments:{action:'status',proposalId:p.proposalId}};assert.equal((await f.callback(changed)).status,409);assert.equal(f.creates.length,1);
});
test('live configuration revocation stops new host proposals and replay, but owner can inspect saved candidates',async t=>{
  const f=await fixture(t),e=f.envelope({action:'propose',rule}),first=await(await f.callback(e)).json();writeFileSync(f.hostToolsConfigPath,JSON.stringify({...f.config,tools:{githubPublic:f.config.tools.githubPublic}}),{mode:0o600});
  assert.equal((await f.callback(e)).status,403);assert.equal((await f.callback(f.envelope({action:'propose',rule},'new'))).status,403);assert.equal((await(await f.get(`/api/calendar-proposals/${first.proposal.proposalId}`)).json()).proposal.state,'pending_owner_confirmation');assert.equal(f.creates.length,0);
});
test('calendar host needs explicit owner authentication and simultaneous config flags are rejected',async t=>{
  const f=await fixture(t);assert.throws(()=>createApplication({...f.options,authConfigPath:undefined}),e=>e instanceof ConnectorError&&e.code==='calendar_owner_authentication_required');
  assert.throws(()=>createApplication({...f.options,connectorConfigPath:f.hostToolsConfigPath}),e=>e instanceof ConnectorError&&e.code==='host_tools_config_ambiguous');assert.equal(f.creates.length,0);
});
test('shutdown drains an admitted proposal confirmation before closing its transaction store',async t=>{
  const f=await fixture(t),p=await seed(f),body=await payload(f,p);let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r);f.hooks.create=async()=>{began();await new Promise<void>(r=>release=r);};
  const confirming=f.post(`/api/calendar-proposals/${p.proposalId}/confirm`,body);await started;let closed=false;const closing=f.app.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);release();await closing;await confirming;delete f.hooks.create;await f.restart();const saved=await(await f.get(`/api/calendar-proposals/${p.proposalId}`)).json();assert.equal(saved.proposal.state,'admitted');assert.equal(saved.series.occurrence.schedule.status,'queued');assert.equal(f.creates.length,1);
});
