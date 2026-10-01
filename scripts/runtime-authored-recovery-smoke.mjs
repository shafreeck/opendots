/** L2 reconstruction proof: unchanged checksum-pinned Runtime, loopback scripted
 * provider, product-owned document versions and graceful Runtime restart.
 * No external model, private accounts, arbitrary file imports or paid calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createApplication} from '../src/server.ts';
import {RuntimeStore} from '../src/runtime-store.ts';
import {authDigest} from '../src/auth-config.ts';
import {AUTHORED_DOCUMENT_TOOL as TOOL} from '../src/authored-documents.ts';
import {authoredDocumentRegistration} from '../src/authored-document-host.ts';
const binary=resolve(process.env.OPENDOTS_RUNTIME_BINARY||'');
assert.ok(process.env.OPENDOTS_RUNTIME_BINARY,'Set OPENDOTS_RUNTIME_BINARY to the unchanged official Runtime');
const binarySha256=createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(binarySha256,'29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3');
const root=mkdtempSync(join(tmpdir(),'opendots-rebuilt-native-'));mkdirSync(join(root,'workspace'),{mode:0o700});
const token=randomBytes(32).toString('hex'),callbackToken=randomBytes(32).toString('hex'),principalId='reconstruction-native-principal';
const contents=['# Reconstructed document\n\nNew deterministic Markdown content.\n','# Reconstructed document\n\nSecond immutable version.\n'];
const createArgs={action:'create',name:'reconstruction.md',format:'markdown',content:contents[0]};
let child,app,modelCalls=0,stage=0,objectiveId,waitPhase=false,waitUpdates=0,waitSessionId,fixtureFailure,native,product,productOrigin='',productPort=0,cookie='',csrf='',runtimeOutput='',appendArgs;
let loseNextInputResponse=false,lostNativeReceipt;const nativeAdmissionIds=[];
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const closeServer=async s=>{s.closeAllConnections();if(s.listening)await new Promise(r=>s.close(r));};
const freePort=async()=>{const s=createServer(),p=await listen(s);await closeServer(s);return p;};
const provider=createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<4*1024*1024);}
  const input=JSON.parse(raw);assert.ok(++modelCalls<=20,'No unbounded fixture loop');let call;
  const bound=/\(objective-binding (?:\(id )?"?objective-/.test(JSON.stringify(input.messages));
  if(bound){
   while(!objectiveId)await new Promise(r=>setTimeout(r,10));
   if(waitPhase){
    const rawMessages=JSON.stringify(input.messages),desired=rawMessages.includes('EXACT_WAIT_REPLY_TWO')?3:rawMessages.includes('EXACT_WAIT_REPLY_ONE')?2:1;
    if(desired>waitUpdates){const view=await native('/api/contexts/'+(await product('/api/state')).binding.contextId+'/scheduler'),o=view.objectives.map(v=>v.objective??v).find(o=>o.id===objectiveId);assert.ok(o);call={id:'rebuild-wait-'+desired,type:'function',function:{name:'objective_update',arguments:JSON.stringify({objective_id:objectiveId,base_revision:o.revision,status:desired===3?'completed':'active',reason:desired===3?'Both exact user inputs were observed.':'Wait for explicit user input '+desired,evidence_refs:[],...(desired<3?{wait_condition:{kind:'user_input',session_id:waitSessionId}}:{})})}};waitUpdates=desired;}
   }else if(stage===0){assert.ok(input.tools.some(t=>t.function?.name===TOOL));call={id:'rebuild-create',type:'function',function:{name:TOOL,arguments:JSON.stringify(createArgs)}};stage++;}
   else if(stage===1){const listed=await product('/api/authored-documents');assert.equal(listed.documents.length,1);const d=listed.documents[0];appendArgs={action:'append',documentId:d.id,expectedRevision:1,parentVersionId:d.currentVersionId,content:contents[1]};call={id:'rebuild-append',type:'function',function:{name:TOOL,arguments:JSON.stringify(appendArgs)}};stage++;}
   else if(stage===2){const d=(await product('/api/authored-documents')).documents[0];assert.equal(d.revision,2);const o=(await native('/api/contexts/'+(await product('/api/state')).binding.contextId+'/scheduler')).objectives.map(v=>v.objective??v).find(o=>o.id===objectiveId);assert.ok(o);call={id:'rebuild-complete',type:'function',function:{name:'objective_update',arguments:JSON.stringify({objective_id:objectiveId,base_revision:o.revision,status:'completed',reason:'Two exact immutable Markdown versions have been saved and verified.',evidence_refs:[]})}};stage++;}
  }
  const latestUser=JSON.stringify([...input.messages].reverse().find(m=>m.role==='user'));
  const message=call?{role:'assistant',content:'',tool_calls:[call]}:{role:'assistant',content:bound?'REBUILT_TASK_COMPLETE':latestUser.includes('OFFLINE_PENDING_MESSAGE')?'REBUILT_PENDING_ACK':'REBUILT_UNKNOWN_ACK'};
  const finish=call?'tool_calls':'stop';
  if(input.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:randomUUID(),choices:[{index:0,delta:call?{role:'assistant',tool_calls:[{...call,index:0}]}:message,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:randomUUID(),choices:[{index:0,message,finish_reason:finish}]}));}
 }catch(e){fixtureFailure=e;res.writeHead(500);res.end('Deterministic fixture failed');}
});
async function stopRuntime(){if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(r=>{const timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('close',()=>{clearTimeout(timer);r();});});}}
async function wait(check,label){const until=Date.now()+25_000;while(Date.now()<until){if(fixtureFailure)throw fixtureFailure;if(await check())return;await new Promise(r=>setTimeout(r,75));}throw Error('Timed out: '+label);}
try{
 const providerPort=await listen(provider),runtimePort=await freePort(),callbackPort=await freePort(),origin=`http://127.0.0.1:${runtimePort}`;
 const dbPath=join(root,'product.db'),s=new RuntimeStore(dbPath),binding=s.ensureBinding(origin);s.close();
 const manifest=join(root,'manifest.json'),config=join(root,'runtime.toml'),hostToolsConfigPath=join(root,'hosts.json'),authConfigPath=join(root,'auth.json');
 const endpoint=`http://127.0.0.1:${callbackPort}/api/host-tools/documents/call`;
 writeFileSync(manifest,JSON.stringify({protocol:1,tools:[authoredDocumentRegistration({contextId:binding.contextId,endpoint,token:callbackToken})]}),{mode:0o600});
 writeFileSync(config,`[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(join(root,'workspace'))}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root,'artifacts'))}\n`,{mode:0o600});
 const launchRuntime=()=>{child=spawn(binary,['serve','--bind',`127.0.0.1:${runtimePort}`,'--cwd',root,'--config-file',config,'--log-level','warn'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,USERPROFILE:root,MORPHZ_HOME:join(root,'home'),MORPHZ_DASHBOARD_TOKEN:token,MORPHZ_HOST_TOOLS_FILE:manifest,MORPHZ_PRINCIPAL_ID:principalId,MORPHZ_STORAGE_SQLITE_PATH:join(root,'runtime.db'),LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});child.on('error',e=>fixtureFailure=e);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>runtimeOutput=(runtimeOutput+b).slice(-12000));};
 native=async(path,input,method=input===undefined?'GET':'POST')=>{const r=await fetch(origin+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',connection:'close'},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(3000)});assert.ok(r.ok,`Native ${r.status} ${path}`);return r.json();};
 const nativeReady=()=>wait(async()=>{try{return(await native('/api/session-io/capabilities')).enabled===true;}catch{return false;}},'native startup');
 launchRuntime();await nativeReady();await native('/api/agents',{id:binding.agentId,root_context_id:binding.contextId,initial_session_id:binding.sessionId,title:'Disposable reconstruction fixture'});await native(`/api/agents/${binding.agentId}/provider-accounts/fixture`,undefined,'PUT');
 const saved=new RuntimeStore(dbPath);saved.verifyBinding(await native('/api/sessions/'+binding.sessionId),principalId);saved.close();
 writeFileSync(hostToolsConfigPath,JSON.stringify({version:2,ownerId:binding.userId,runtimeOrigin:origin,binding:{principalId,agentId:binding.agentId,contextId:binding.contextId,sessionId:binding.sessionId},callbackPort,tools:{authoredDocuments:{callbackToken,allowAuthoring:true}}}),{mode:0o600});
 writeFileSync(authConfigPath,JSON.stringify({version:1,credential:{kind:'morphz_login_token_sha256',hashHex:authDigest(token)},sessionTtlSeconds:3600,idleTtlSeconds:600,maximumDevices:8}),{mode:0o600});
 const rawProduct=(path,input)=>fetch(productOrigin+path,{method:input===undefined?'GET':'POST',headers:{origin:productOrigin,cookie,'content-type':'application/json',connection:'close','x-opendots-csrf':csrf},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(12_000)});
 product=async(path,input)=>{const r=await rawProduct(path,input),body=await r.json();assert.ok(r.ok,`Product ${r.status} ${path}: ${JSON.stringify(body)}`);return body;};
 const openApp=async()=>{app=createApplication({dbPath,baseUrl:origin,operatorToken:token,authConfigPath,hostToolsConfigPath,pollIntervalMs:150,streamEnabled:false,fetch:async(url,init)=>{const path=new URL(String(url)).pathname,isInput=init?.method==='POST'&&path.endsWith('/io/messages');if(isInput)nativeAdmissionIds.push(JSON.parse(init.body).client_message_id);const response=await fetch(url,init);if(isInput&&loseNextInputResponse&&response.ok){loseNextInputResponse=false;lostNativeReceipt=await response.json();throw new TypeError('Synthetic lost response after actual native admission');}return response;}});await new Promise(r=>app.server.listen(productPort,'127.0.0.1',r));await app.ready;productPort=app.server.address().port;productOrigin=`http://127.0.0.1:${productPort}`;const login=await fetch(productOrigin+'/api/auth/login',{method:'POST',headers:{origin:productOrigin,'content-type':'application/json'},body:JSON.stringify({credential:token,deviceLabel:'Reconstruction fixture'})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).session.csrfToken;};
 await openApp();await wait(()=>app.hostTools.authoringSnapshot().status==='ready','document host startup');
 const admitted=await product('/api/jobs',{prompt:'Save two immutable Markdown versions using the document host, then complete.',idempotencyKey:'reconstructed-native-task'});objectiveId=admitted.receipt.objective.id;
 await wait(async()=>(await product('/api/state')).jobs.some(j=>j.id===objectiveId&&j.status==='completed'),'native task completion');
 const document=(await product('/api/authored-documents')).documents[0],history=await product('/api/authored-documents/'+document.id),versions=history.versions.sort((a,b)=>a.revision-b.revision);
 assert.equal(versions.length,2);assert.equal(versions[1].parentVersionId,versions[0].id);
 for(let i=0;i<2;i++){assert.equal(versions[i].provenance.objectiveId,objectiveId);const r=await rawProduct(versions[i].downloadPath);assert.equal(r.status,200);assert.equal(await r.text(),contents[i]);assert.equal(versions[i].sha256,createHash('sha256').update(contents[i]).digest('hex'));}
 assert.equal((await fetch(productOrigin+versions[0].downloadPath)).status,401);
 const detail=await product('/api/jobs/'+objectiveId+'/detail');assert.equal(detail.freshness.fresh,true);assert.equal(detail.authoredDocuments.items.length,2);
 const provenance=versions[0].provenance,envelope={protocol:1,tool:TOOL,invocation:{job_id:provenance.jobId,tool_call_id:provenance.callId,thread_id:provenance.threadId,principal_id:principalId,agent_id:binding.agentId,context_id:binding.contextId,session_id:binding.sessionId,target_id:'target-default'},arguments:createArgs};
 const replay=async(value=envelope)=>{const r=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${callbackToken}`,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(8000)});return{status:r.status,body:await r.json()};};
 const firstReplay=await replay();assert.equal(firstReplay.status,200);assert.equal(firstReplay.body.version.id,versions[0].id);assert.ok((await replay({...envelope,arguments:{...createArgs,content:'Changed'}})).status>=400);
 await app.close();app=undefined;await openApp();await wait(()=>app.hostTools.authoringSnapshot().status==='ready','host after BFF restart');assert.deepEqual((await replay()).body,firstReplay.body);
 const authoredObjectiveId=objectiveId;waitPhase=true;objectiveId=undefined;waitSessionId=binding.sessionId;
 const waiting=await product('/api/jobs',{prompt:'Wait for two exact current-wait inputs, then finish.',idempotencyKey:'reconstructed-wait-objective'});objectiveId=waiting.receipt.objective.id;
 let target;await wait(async()=>{target=await product('/api/jobs/'+objectiveId+'/input-target');return target.waitInputAvailable===true;},'first native user wait');
 assert.equal(target.questionText,null);assert.equal(target.requiresConfirmation,true);
 const firstInput={text:'EXACT_WAIT_REPLY_ONE',idempotencyKey:'exact-wait-response-one',expectedGeneration:target.generation,expectedSessionId:binding.sessionId,replyToRequestId:target.replyRequestId,acknowledgeQuestionUnavailable:true};
 const firstAdmission=await product('/api/jobs/'+objectiveId+'/input',firstInput);let secondTarget;
 await wait(async()=>{secondTarget=await product('/api/jobs/'+objectiveId+'/input-target');return secondTarget.waitInputAvailable===true&&secondTarget.replyRequestId!==target.replyRequestId;},'newer native user wait');
 const repeated=await product('/api/jobs/'+objectiveId+'/input',firstInput);assert.equal(repeated.id,firstAdmission.id);assert.equal((await product('/api/jobs/'+objectiveId+'/input-target')).replyRequestId,secondTarget.replyRequestId);
 const staleInput=await rawProduct('/api/jobs/'+objectiveId+'/input',{...firstInput,idempotencyKey:'different-stale-wait-key'});assert.equal(staleInput.status,409);
 await product('/api/jobs/'+objectiveId+'/input',{text:'EXACT_WAIT_REPLY_TWO',idempotencyKey:'exact-wait-response-two',expectedGeneration:secondTarget.generation,expectedSessionId:binding.sessionId,replyToRequestId:secondTarget.replyRequestId,acknowledgeQuestionUnavailable:true});
 await wait(async()=>(await product('/api/state')).jobs.some(j=>j.id===objectiveId&&j.status==='completed'),'second wait task completion');waitPhase=false;objectiveId=authoredObjectiveId;

 const unknownBody={text:'UNCERTAIN_RECOVERY_MESSAGE',idempotencyKey:'reconstructed-unknown-chat'};loseNextInputResponse=true;
 const unknownResponse=await rawProduct('/api/chat',unknownBody);assert.ok(unknownResponse.status>=500);const unknownBefore=await product('/api/commands/'+unknownBody.idempotencyKey);assert.equal(unknownBefore.command.status,'unknown');assert.ok(lostNativeReceipt?.event_id);
 await wait(async()=>(await native('/api/sessions/'+binding.sessionId+'/io/events')).events.some(e=>e.type==='output.committed'&&JSON.stringify(e).includes('REBUILT_UNKNOWN_ACK')),'actual accepted unknown output');
 await stopRuntime();await app.close();app=undefined;await openApp();assert.equal(await(await rawProduct(versions[0].downloadPath)).text(),contents[0]);
 const stale=await product('/api/jobs/'+objectiveId+'/detail');assert.equal(stale.freshness.fresh,false);
 const retryBody={text:'OFFLINE_PENDING_MESSAGE',idempotencyKey:'reconstructed-offline-chat'};const offline=await rawProduct('/api/chat',retryBody);assert.ok(offline.status>=500);const before=await product('/api/commands/'+retryBody.idempotencyKey);assert.ok(before.command);assert.ok(['pending','unknown'].includes(before.command.status));
 launchRuntime();await nativeReady();await wait(()=>app.hostTools.authoringSnapshot().status==='ready','automatic host reconnect');
 const recoveredUnknown=await product('/api/chat',unknownBody);assert.equal(recoveredUnknown.id,unknownBefore.command.id);assert.equal(recoveredUnknown.receipt.event_id,lostNativeReceipt.event_id);
 const recovered=await product('/api/chat',retryBody);assert.equal(recovered.id,before.command.id);
 await wait(async()=>(await product('/api/state')).messages.some(m=>m.text==='REBUILT_PENDING_ACK'),'recovered committed output');
 const recoveredMessages=(await product('/api/state')).messages;assert.equal(recoveredMessages.filter(m=>m.text==='REBUILT_UNKNOWN_ACK').length,1);assert.equal(recoveredMessages.filter(m=>m.text==='REBUILT_PENDING_ACK').length,1);assert.ok(nativeAdmissionIds.filter(id=>id===unknownBefore.command.id).length>=2);
 assert.deepEqual((await replay()).body,firstReplay.body);assert.equal((await product('/api/authored-documents/'+document.id)).versions.length,2);assert.equal((await product('/api/state')).binding.sessionId,binding.sessionId);
 console.log(JSON.stringify({level:'L2',result:'passed',runtime:'unchanged official v0.1.3',binarySha256,modelCalls,paidCalls:0,immutableVersions:2,exactNativeTaskProvenance:true,authenticatedBytesAndHashes:true,originalCallReplay:true,changedArgumentsRejected:true,bffRestarts:2,runtimeRestarts:1,offlineBytes:true,staleTaskMarked:true,durableOfflineCommand:true,actualAcceptedUnknownAdmissionRecovered:true,oneOutputPerRecoveredChat:true,exactNativeWaitResponses:2,olderWaitReceiptDoesNotResolveNewerWait:true,automaticCallbackRecovery:true,realModel:false,browserAcceptance:false},null,2));
}catch(error){console.error('Reconstruction native fixture failed:',error);console.error(JSON.stringify({stage,objectiveId,modelCalls,runtimeOutput}));process.exitCode=1;}
finally{await app?.close();await stopRuntime();await closeServer(provider);rmSync(root,{recursive:true,force:true});}
