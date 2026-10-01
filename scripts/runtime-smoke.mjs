/** L2 integration: actual pinned Morphz binary + deterministic local model fixture.
 * Never loads user configuration, secrets or external model endpoints.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
const productMode=process.argv.includes('--product');
let product;let acknowledgedNotice;
const binary=process.env.OPENDOTS_RUNTIME_BINARY;
if(!binary||!existsSync(binary))throw Error('Set OPENDOTS_RUNTIME_BINARY to a verified Morphz binary; no automatic download or paid provider calls.');
const root=mkdtempSync(join(tmpdir(),'opendots-real-runtime-'));
const token=randomBytes(32).toString('hex');
let calls=0,toolDispatched=false;const seenTools=new Set();
let approvalPhase=false,approvalDispatched=false,memoryPhase=false,memoryDispatched=false;
let objectivePhase=false,objectiveId='',objectiveContext='',objectiveStage=0,objectiveStarted=false,objectiveReleased=false;
let operatorApi;const fixtureToolResults=[];
const provider=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const input=JSON.parse(Buffer.concat(chunks).toString());calls++;for(const m of input.messages??[])if(m.role==='tool')fixtureToolResults.push(m.content);
  for(const t of input.tools??[])seenTools.add(t.function?.name);
  const objectiveBound=objectivePhase && JSON.stringify(input.messages).match(/\(objective-binding (?:\(id )?\"?objective-/);
  let call;
  if(memoryPhase&&!memoryDispatched){memoryDispatched=true;const view=await operatorApi(`/api/contexts/${objectiveContext}/overview`);call={id:'memory-create-fixture',type:'function',function:{name:'context_tx',arguments:JSON.stringify({transaction:`(context-tx (base-version ${view.mind_revision}) (reason \"Controlled memory fixture\") (create user-memory-fixture (fact \"opendots memory fixture\")))`})}};}
  else if(approvalPhase&&!approvalDispatched){approvalDispatched=true;call={id:'approval-denial-fixture',type:'function',function:{name:'write',arguments:JSON.stringify({path:root+'-outside.txt',content:'This must never be written',mode:'create'})}};}
  else if(objectiveBound){
    if(objectiveStage++===0){objectiveStarted=true;while(!objectiveId)await new Promise(r=>setTimeout(r,10));while(!objectiveReleased)await new Promise(r=>setTimeout(r,20));call={id:'objective-file',type:'function',function:{name:'write',arguments:JSON.stringify({path:join(root,'objective.txt'),content:'Native Objective produced this artifact.\n',mode:'create'})}};}
    else if(objectiveStage===2){const view=await operatorApi(`/api/contexts/${objectiveContext}/overview`);const objective=view.objectives.find(o=>o.id===objectiveId);assert.ok(existsSync(join(root,'objective.txt')));call={id:'objective-complete',type:'function',function:{name:'objective_update',arguments:JSON.stringify({objective_id:objectiveId,base_revision:objective.revision,status:'completed',reason:'The controlled artifact exists and has the expected bytes.',evidence_refs:[]})}};}
    else call=null;
  }else call=!toolDispatched?{id:'fixture-write',type:'function',function:{name:'write',arguments:JSON.stringify({path:join(root,'proof.txt'),content:'Actual Morphz write tool executed. Synthetic model only.\n',mode:'create'})}}:null;
  if(call)toolDispatched=true;
  const message=call?{role:'assistant',content:'',tool_calls:[call]}:{role:'assistant',content:'RUNTIME_FIXTURE_DONE'};
  if(input.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:randomUUID(),choices:[{index:0,delta:call?{role:'assistant',tool_calls:[{...call,index:0}]}:message,finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:randomUUID(),choices:[{index:0,message,finish_reason:call?'tool_calls':'stop'}]}));}
 }catch{res.writeHead(500);res.end('fixture failure');}
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const providerPort=provider.address().port;
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const config=join(root,'runtime.toml');
writeFileSync(config,`[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(root)}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root,'artifacts'))}\n`,{mode:0o600});
const env={PATH:process.env.PATH,HOME:root,USERPROFILE:root,MORPHZ_HOME:join(root,'home'),MORPHZ_DASHBOARD_TOKEN:token,MORPHZ_STORAGE_SQLITE_PATH:join(root,'runtime.db'),LANG:'C.UTF-8'};
let runtime;let output='';
function launch(){runtime=spawn(resolve(binary),['serve','--bind',`127.0.0.1:${port}`,'--cwd',root,'--config-file',config,'--log-level','warn'],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const stream of [runtime.stdout,runtime.stderr])stream.on('data',c=>{output=(output+c.toString()).slice(-16000);});}
async function stop(){if(runtime&&runtime.exitCode===null){runtime.kill('SIGTERM');await new Promise(r=>runtime.once('exit',r));}}
const origin=`http://127.0.0.1:${port}`;
async function api(path,body,method=body?'POST':'GET'){const response=await fetch(origin+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});const result=await response.json();if(!response.ok)throw Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result)}`);return result;}
operatorApi=api;
async function wait(fn,label,ms=20_000){const end=Date.now()+ms;while(Date.now()<end){if(runtime.exitCode!==null)throw Error('Runtime exited: '+output);if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label+' timed out: '+output);}
try{
 launch();await wait(async()=>{try{return (await api('/api/session-io/capabilities')).enabled;}catch{return false;}},'readiness');
 let sessionId='opendots-test-session';let productOrigin='',csrf='';
 async function productApi(path,body){const response=await fetch(productOrigin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-opendots-csrf':csrf},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(`Product HTTP ${response.status} ${path}: ${JSON.stringify(result)}`);return result;}
 async function startProduct(){const {createApplication}=await import('../src/server.ts');product=createApplication({dbPath:join(root,'opendots.db'),baseUrl:origin,operatorToken:token,pollIntervalMs:100});await new Promise(r=>product.server.listen(0,'127.0.0.1',r));productOrigin=`http://127.0.0.1:${product.server.address().port}`;await wait(async()=>{const state=await productApi('/api/state');csrf=state.csrfToken;return state.runtime.status==='ready';},'product ready');}
 if(productMode){await startProduct();const state=await productApi('/api/state');sessionId=state.sessionId;await productApi('/api/models/account',{accountId:'fixture'});assert.ok(!(JSON.stringify(await productApi('/api/models'))).includes(token));}
 else{await api('/api/agents',{id:'opendots-test-agent',root_context_id:'opendots-test-context',initial_session_id:sessionId,title:'opendots isolated test'});await api('/api/agents/opendots-test-agent/provider-accounts/fixture',undefined,'PUT');}
 const input={io_version:'1',client_message_id:'opendots-runtime-smoke-1',message:{format:{id:'morphz.chat',version:'1'},content:{encoding:'json',value:{text:'Create the controlled fixture file.'}}},activation:{dispatch_mode:'parallel'}};
 const chatBody={text:'Create the controlled fixture file.',idempotencyKey:'product-smoke-command-1'};
 const receipt=productMode?(await productApi('/api/chat',chatBody)).receipt:await api(`/api/sessions/${sessionId}/io/messages`,input);
 const repeated=productMode?(await productApi('/api/chat',chatBody)).receipt:await api(`/api/sessions/${sessionId}/io/messages`,input);assert.equal(receipt.event_id,repeated.event_id);
 await wait(async()=>existsSync(join(root,'proof.txt')),'actual write tool');
 assert.match(readFileSync(join(root,'proof.txt'),'utf8'),/Actual Morphz write tool executed/);
 let finalPage;await wait(async()=>{finalPage=await api(`/api/sessions/${sessionId}/io/events`);return finalPage.events.some(e=>e.type==='output.committed'&&JSON.stringify(e).includes('RUNTIME_FIXTURE_DONE'));},'committed output');
 assert.ok(seenTools.has('write'));assert.ok(calls>=2);
 if(productMode)await wait(async()=>{const state=await productApi('/api/state');return state.messages.some(m=>m.text==='RUNTIME_FIXTURE_DONE');},'product committed projection');
 if(productMode){
  objectivePhase=true;const state=await productApi('/api/state');objectiveContext=state.binding.contextId;
  const admitted=await productApi('/api/jobs',{prompt:'Create the controlled objective.txt artifact and finish.',idempotencyKey:'objective-smoke-key-1'});objectiveId=admitted.receipt.objective.id;
  await wait(async()=>objectiveStarted,'native Objective evaluation');
  const previousAnswers=(await productApi('/api/state')).messages.filter(m=>m.role==='assistant').length;
  await productApi('/api/chat',{text:'CONCURRENT_CHAT while objective is waiting',idempotencyKey:'parallel-chat-smoke-key'});
  await wait(async()=>{const state=await productApi('/api/state');return state.messages.filter(m=>m.role==='assistant').length>previousAnswers;},'chat while native objective evaluation waits');
  objectiveReleased=true;
  await wait(async()=>{const state=await productApi('/api/state');return state.jobs.some(j=>j.id===objectiveId&&j.status==='completed');},'authoritative Objective completion');
  assert.match(readFileSync(join(root,'objective.txt'),'utf8'),/Native Objective/);
  await wait(async()=>{const n=await productApi('/api/notifications');acknowledgedNotice=n.items.find(i=>i.kind==='objective'&&i.sourceId===objectiveId);return Boolean(acknowledgedNotice);},'durable task notification');
  await productApi('/api/notifications/ack',{ids:[acknowledgedNotice.id]});
  const reminderInput={intent:'Controlled future reminder',at:new Date(Date.now()+86400000).toISOString(),timeZone:'Etc/UTC',idempotencyKey:'reminder-runtime-smoke'};
  const reminder=await productApi('/api/reminders',reminderInput);
  const repeatReminder=await productApi('/api/reminders',reminderInput);assert.equal(reminder.id,repeatReminder.id);
  const paused=await productApi(`/api/reminders/${reminder.id}/control`,{action:'pause',expectedRevision:reminder.revision});assert.equal(paused.status,'paused');
  const cancelled=await productApi(`/api/reminders/${reminder.id}/control`,{action:'cancel',expectedRevision:paused.revision});assert.equal(cancelled.status,'cancelled');
  assert.equal((await productApi('/api/reminders')).reminders[0].schedule.status,'cancelled');
  approvalPhase=true;const beforeApprovalOutputs=(await productApi('/api/state')).messages.filter(m=>m.role==='assistant').length;
  await productApi('/api/chat',{text:'APPROVAL_FIXTURE attempt denied out-of-scope write',idempotencyKey:'approval-fixture-key'});
  let pendingApproval;await wait(async()=>{const state=await productApi('/api/state');pendingApproval=state.approvals.find(a=>a.status==='pending_human'||a.status==='pending_auto');return Boolean(pendingApproval);},'actual pending permission');
  await productApi(`/api/approvals/${pendingApproval.id}/decision`,{decision:'deny',expectedRevision:pendingApproval.revision,idempotencyKey:'approval-deny-command'});
  await wait(async()=>{const state=await productApi('/api/state');return !state.approvals.some(a=>a.id===pendingApproval.id&&['pending_human','pending_auto'].includes(a.status));},'actual denied approval');
  assert.equal(existsSync(root+'-outside.txt'),false);
  await wait(async()=>{const state=await productApi('/api/state');return state.messages.filter(m=>m.role==='assistant').length>beforeApprovalOutputs;},'denial final report');
  memoryPhase=true;
  await productApi('/api/chat',{text:'MEMORY_FIXTURE persist controlled Frame',idempotencyKey:'memory-fixture-key'});
  let memory;await wait(async()=>{try{memory=await productApi('/api/memory/read',{frameId:'user-memory-fixture'});return memory.body.includes('opendots memory fixture');}catch{return false;}},'native Frame memory');
  assert.equal(memory.capabilities.forget,false);
  await wait(async()=>{const result=await productApi('/api/memory/search',{query:'opendots memory fixture'});return result.frames.some(f=>f.id==='user-memory-fixture');},'Frame recall index');
  finalPage=await api(`/api/sessions/${sessionId}/io/events`);
 }
 const count=finalPage.events.length;if(product){await product.close();product=undefined;}await stop();launch();await wait(async()=>{try{return (await api('/api/session-io/capabilities')).enabled;}catch{return false;}},'restart readiness');
 const persisted=await api(`/api/sessions/${sessionId}/io/events`);for(const original of finalPage.events){const recovered=persisted.events.find(e=>e.event_id===original.event_id);assert.deepEqual(recovered,original);}
 assert.equal(persisted.events.filter(e=>e.type==='input.accepted').length,finalPage.events.filter(e=>e.type==='input.accepted').length);
 if(productMode){await startProduct();assert.equal((await productApi('/api/state')).sessionId,sessionId);const notices=await productApi('/api/notifications');assert.equal(notices.items.find(n=>n.id===acknowledgedNotice.id).read,true);assert.equal(notices.items.filter(n=>n.id===acknowledgedNotice.id).length,1);}
 const replay=productMode?(await productApi('/api/chat',chatBody)).receipt:await api(`/api/sessions/${sessionId}/io/messages`,input);assert.equal(replay.event_id,receipt.event_id);
 console.log(JSON.stringify({level:'L2',result:'passed',runtime:'actual Morphz',provider:'deterministic local fixture',productBff:productMode,nativeObjectiveAndConcurrentChat:productMode,nativeReminderLifecycle:productMode,realApprovalDenial:productMode,nativeFrameRecall:productMode,inAppNotificationDurability:productMode,verified:['authenticated startup','typed IO durable admission','same-ID retry','actual write tool and file bytes','committed output','restart history and receipt identity'],paidCalls:0,providerCalls:calls},null,2));
}catch(e){console.error('Runtime smoke failed:',e.message);if(product)console.error(JSON.stringify({objectiveStage,objectiveId,toolResults:fixtureToolResults,jobs:product.runtime.snapshot().jobs},null,2));process.exitCode=1;}
finally{if(product)await product.close();await stop();await new Promise(r=>provider.close(r));rmSync(root,{recursive:true,force:true});}
