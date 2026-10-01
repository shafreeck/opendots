/** Optional L2: unchanged official Runtime, real product callback and owner API,
 * deterministic loopback model, future occurrence only. No external provider,
 * paid calls, execution tools, or direct native database writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer,type Server } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.ts';
import { RuntimeStore } from '../src/runtime-store.ts';
import { authDigest } from '../src/auth-config.ts';
import { CALENDAR_TOOL } from '../src/calendar-proposals.ts';
import { calendarProposalRegistration } from '../src/calendar-proposal-host.ts';
import { HOST_CALENDAR_PATH } from '../src/host-tools-listener.ts';

test('official Runtime proposes through product host; only owner confirmation admits the exact future series', {skip:!process.env.OPENDOTS_RUNTIME_BINARY,timeout:60_000},async()=>{
  const binary=resolve(process.env.OPENDOTS_RUNTIME_BINARY!);assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),'29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3');
  const root=mkdtempSync(join(tmpdir(),'opendots-proposal-native-'));mkdirSync(join(root,'workspace'),{mode:0o700});
  const rule={intent:'Future owner-confirmed calendar fixture',timeZone:'Asia/Shanghai',frequency:'daily',localTime:'09:30',startDate:'2030-01-01',untilDate:'2030-01-15',dst:{gap:'skip',overlap:'earlier'},missed:'skip_unsubmitted',resume:'skip_overdue_paused'};
  const args={action:'propose',rule},token='a'.repeat(64),callbackToken='b'.repeat(64),credential=token,principalId='calendar-proposal-fixture';
  let modelCalls=0,modelSawPending=false,fixtureFailure:unknown,child:ChildProcess|undefined,app:ReturnType<typeof createApplication>|undefined;
  const provider=createServer(async(request,response)=>{
    try{const chunks:Buffer[]=[];let size=0;for await(const part of request){const b=Buffer.from(part);size+=b.length;assert.ok(size<=4*1024*1024);chunks.push(b);}const input=JSON.parse(Buffer.concat(chunks).toString());assert.ok(++modelCalls<=4);
      const tool=(input.messages??[]).find((m:any)=>m.role==='tool');let message:any,finish:string;
      if(!tool){assert.ok(input.tools.some((t:any)=>t.function?.name===CALENDAR_TOOL));message={role:'assistant',content:'',tool_calls:[{id:'calendar-proposal-fixed-call',type:'function',function:{name:CALENDAR_TOOL,arguments:JSON.stringify(args)}}]};finish='tool_calls';}
      else{assert.ok(JSON.stringify(tool).includes('pending_owner_confirmation'));assert.ok(JSON.stringify(tool).includes('not_admitted'));modelSawPending=true;message={role:'assistant',content:'CALENDAR_PROPOSAL_PENDING_OWNER_REVIEW'};finish='stop';}
      if(input.stream){const delta=message.tool_calls?{role:'assistant',tool_calls:message.tool_calls.map((c:any)=>({...c,index:0}))}:message;response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:randomUUID(),choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);}
      else{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id:randomUUID(),choices:[{index:0,message,finish_reason:finish}]}));}
    }catch(error){fixtureFailure=error;response.writeHead(500);response.end('Local deterministic model failed');}
  });
  const listen=(s:Server)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address()as any).port)));
  const closeServer=async(s:Server)=>{s.closeAllConnections();if(s.listening)await new Promise<void>(r=>s.close(()=>r()));};
  const freePort=async()=>{const s=createServer(),port=await listen(s);await closeServer(s);return port;};
  let productOrigin='',cookie='',csrf='',productPort=0,nativeScheduleCreates=0;
  try{
    const providerPort=await listen(provider),runtimePort=await freePort(),callbackPort=await freePort(),origin=`http://127.0.0.1:${runtimePort}`;
    const dbPath=join(root,'product.db'),saved=new RuntimeStore(dbPath),binding=saved.ensureBinding(origin);saved.close();
    const manifest=join(root,'host-tools.json'),config=join(root,'runtime.toml'),hostToolsConfigPath=join(root,'product-hosts.json'),authConfigPath=join(root,'auth.json');
    writeFileSync(manifest,JSON.stringify({protocol:1,tools:[calendarProposalRegistration({contextId:binding.contextId,endpoint:`http://127.0.0.1:${callbackPort}${HOST_CALENDAR_PATH}`,token:callbackToken})]}),{mode:0o600});
    writeFileSync(config,`[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(join(root,'workspace'))}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root,'artifacts'))}\n`,{mode:0o600});
    child=spawn(binary,['serve','--bind',`127.0.0.1:${runtimePort}`,'--cwd',root,'--config-file',config,'--log-level','warn'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,USERPROFILE:root,MORPHZ_HOME:join(root,'home'),MORPHZ_DASHBOARD_TOKEN:token,MORPHZ_HOST_TOOLS_FILE:manifest,MORPHZ_PRINCIPAL_ID:principalId,MORPHZ_STORAGE_SQLITE_PATH:join(root,'runtime.db'),LANG:'C.UTF-8'},stdio:'ignore'});
    child.on('error',()=>{fixtureFailure=Error('Isolated official Runtime spawn failed');});
    const native=async(path:string,input?:unknown,method=input===undefined?'GET':'POST')=>{const r=await fetch(origin+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',connection:'close'},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(3_000),redirect:'error'});assert.ok(r.ok,`Native HTTP ${r.status}`);return r.json()as Promise<any>;};
    const wait=async(check:()=>Promise<boolean>)=>{const until=Date.now()+25_000;while(Date.now()<until){if(fixtureFailure)throw fixtureFailure;assert.equal(child!.exitCode,null);if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Bounded calendar proposal fixture timeout');};
    await wait(async()=>{try{return(await native('/api/session-io/capabilities')).enabled===true;}catch{return false;}});
    await native('/api/agents',{id:binding.agentId,root_context_id:binding.contextId,initial_session_id:binding.sessionId,title:'Disposable calendar proposal fixture'});await native(`/api/agents/${binding.agentId}/provider-accounts/fixture`,undefined,'PUT');
    const store=new RuntimeStore(dbPath);store.verifyBinding(await native(`/api/sessions/${binding.sessionId}`),principalId);store.close();
    writeFileSync(hostToolsConfigPath,JSON.stringify({version:2,ownerId:binding.userId,runtimeOrigin:origin,binding:{principalId,agentId:binding.agentId,contextId:binding.contextId,sessionId:binding.sessionId},callbackPort,tools:{calendarProposals:{callbackToken,allowProposals:true}}}),{mode:0o600});
    writeFileSync(authConfigPath,JSON.stringify({version:1,credential:{kind:'morphz_login_token_sha256',hashHex:authDigest(credential)},sessionTtlSeconds:3600,idleTtlSeconds:600,maximumDevices:4}),{mode:0o600});
    const product=async(path:string,input?:unknown)=>{const r=await fetch(productOrigin+path,{method:input===undefined?'GET':'POST',headers:{origin:productOrigin,cookie,'content-type':'application/json',connection:'close','x-opendots-csrf':csrf},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(10_000),redirect:'error'});assert.ok(r.ok,`Product HTTP ${r.status}`);return r.json()as Promise<any>;};
    const openApp=async()=>{app=createApplication({dbPath,baseUrl:origin,operatorToken:token,authConfigPath,hostToolsConfigPath,autoStart:false,streamEnabled:false,fetch:async(url,init)=>{if(init?.method==='POST'&&new URL(String(url)).pathname.endsWith('/schedules'))nativeScheduleCreates++;return fetch(url,init);}});await new Promise<void>(r=>app!.server.listen(productPort,'127.0.0.1',r));await app.ready;await app.hostTools!.start();productPort=(app.server.address()as any).port;productOrigin=`http://127.0.0.1:${productPort}`;const login=await fetch(productOrigin+'/api/auth/login',{method:'POST',headers:{origin:productOrigin,connection:'close','content-type':'application/json'},body:JSON.stringify({credential,deviceLabel:'Isolated proposal fixture'})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0]!;csrf=(await login.json()).session.csrfToken;};
    await openApp();await product('/api/chat',{text:'Propose the fixed daily calendar fixture and await owner review.',idempotencyKey:'calendar-proposal-fixture-chat'});
    await wait(async()=> (await native(`/api/sessions/${binding.sessionId}/io/events`)).events.some((e:any)=>e.type==='output.committed'&&JSON.stringify(e).includes('CALENDAR_PROPOSAL_PENDING_OWNER_REVIEW')));
    assert.equal(modelSawPending,true);const listed=await product('/api/calendar-proposals');assert.equal(listed.proposals.length,1);assert.equal(listed.pendingCount,1);const p=listed.proposals[0];assert.equal(p.state,'pending_owner_confirmation');assert.equal(p.scheduling,'not_admitted');assert.equal((await product('/api/calendar-reminders')).series.length,0);
    assert.equal(nativeScheduleCreates,0);
    const job=await native(`/api/execution-jobs/${p.provenance.jobId}`);assert.equal(job.status,'succeeded');assert.equal(job.tool_name,CALENDAR_TOOL);
    const preview=await product(`/api/calendar-proposals/${p.proposalId}/preview`,{expectedRevision:p.revision});const input={expectedRevision:p.revision,ruleFingerprint:p.ruleFingerprint,previewFingerprint:preview.previewFingerprint,confirmed:true};
    const admitted=await product(`/api/calendar-proposals/${p.proposalId}/confirm`,input);assert.equal(admitted.proposal.state,'admitted');assert.equal(admitted.series.occurrence.schedule.status,'queued');const receipt=await native(`/api/sessions/${binding.sessionId}/schedules/${admitted.series.occurrence.id}`);assert.equal(new Date(receipt.not_before).toISOString(),preview.occurrences[0].instant);assert.equal(receipt.interval_seconds,null);
    const envelope={protocol:1,tool:CALENDAR_TOOL,invocation:{job_id:p.provenance.jobId,tool_call_id:p.provenance.callId,thread_id:p.provenance.threadId,principal_id:principalId,agent_id:binding.agentId,context_id:binding.contextId,session_id:binding.sessionId,target_id:'target-default'},arguments:args};
    const replay=await fetch(`http://127.0.0.1:${callbackPort}${HOST_CALENDAR_PATH}`,{method:'POST',headers:{authorization:`Bearer ${callbackToken}`,'content-type':'application/json',connection:'close'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(5_000)});assert.equal(replay.status,200);assert.equal((await replay.json()).proposal.state,'pending_owner_confirmation');
    await app!.close();app=undefined;await openApp();const retry=await product(`/api/calendar-proposals/${p.proposalId}/confirm`,{...input,previewFingerprint:undefined});assert.equal(retry.series.id,admitted.series.id);assert.equal(retry.series.occurrence.id,admitted.series.occurrence.id);assert.equal(nativeScheduleCreates,1);assert.equal((await product('/api/calendar-proposals')).pendingCount,0);
    console.log(JSON.stringify({level:'L2',runtime:'unchanged official v0.1.3',nativeTool:CALENDAR_TOOL,nativeJobStatus:job.status,model:'deterministic loopback',modelCalls,proposalBeforeOwner:'pending_owner_confirmation',nativeScheduleCreateRequestsBeforeOwner:0,nativeScheduleCreateRequestsAfterOwner:nativeScheduleCreates,exactUtcVerified:true,restartSameSeriesAndOccurrence:true,oldCallReceiptImmutable:true,dueTriggers:0,paidCalls:0}));
  }finally{await app?.close();if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise<void>(r=>{const timer=setTimeout(()=>child!.kill('SIGKILL'),2_000);child!.once('close',()=>{clearTimeout(timer);r();});});}await closeServer(provider);rmSync(root,{recursive:true,force:true});}
});
