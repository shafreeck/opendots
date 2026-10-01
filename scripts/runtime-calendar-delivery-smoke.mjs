/** Opt-in actual due-time application delivery. Unchanged pinned Runtime, a
 * deterministic loopback model and one bounded reminder; no exec or paid calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/server.ts';
import {LocalOperatorAdapter} from '../src/morphz-adapter.ts';
const binary=process.env.OPENDOTS_RUNTIME_BINARY;
if(!binary)throw Error('Set OPENDOTS_RUNTIME_BINARY to the verified pinned executable.');
assert.equal(createHash('sha256').update(readFileSync(resolve(binary))).digest('hex'),'29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3');
const root=mkdtempSync(join(tmpdir(),'opendots-calendar-delivery-'));mkdirSync(join(root,'workspace'),{mode:0o700});
const marker='OPENDOTS_CALENDAR_DUE_DELIVERY',token=randomBytes(32).toString('hex');
let runtime,app,productOrigin,csrf,binding,providerCalls=0,modelAnswered=false,providerError;
const provider=createServer(async(request,response)=>{
 try{
  const chunks=[];for await(const c of request)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks));providerCalls++;console.log(JSON.stringify({stage:'local_model_request',call:providerCalls}));
  assert.ok(providerCalls<=4,'Bounded fixture model calls');
  // A scheduled activation has no accepted typed root input. Native docs require
  // ordinary assistant text here; deliver_message requires a typed root contract.
  const message={role:'assistant',content:marker},finish='stop';modelAnswered=true;
  if(input.stream){response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:randomUUID(),choices:[{index:0,delta:message,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);}
  else{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id:randomUUID(),choices:[{index:0,message,finish_reason:finish}]}));}
 }catch(error){providerError=error;response.writeHead(500);response.end('Fixture response rejected');}
});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const providerPort=await listen(provider),probe=createServer(),runtimePort=await listen(probe);await new Promise(r=>probe.close(r));
const nativeOrigin=`http://127.0.0.1:${runtimePort}`,config=join(root,'runtime.toml'),dbPath=join(root,'product.sqlite');
const observer=new LocalOperatorAdapter({baseUrl:nativeOrigin,operatorToken:token,timeoutMs:3000});
writeFileSync(config,`[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(join(root,'workspace'))}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root,'artifacts'))}\n`,{mode:0o600});
async function native(path){const r=await fetch(nativeOrigin+path,{headers:{authorization:`Bearer ${token}`,connection:'close'},signal:AbortSignal.timeout(3000),redirect:'error'});assert.ok(r.ok,`Native HTTP ${r.status}`);return r.json();}
async function product(path,body){const r=await fetch(productOrigin+path,{method:body===undefined?'GET':'POST',headers:{origin:productOrigin,'content-type':'application/json','x-opendots-csrf':csrf??'',connection:'close'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});assert.ok(r.ok,`Product HTTP ${r.status}`);return r.json();}
async function wait(check,label,deadline){while(Date.now()<deadline){if(providerError)throw providerError;if(runtime.exitCode!==null)throw Error('Fixture Runtime exited');if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);}
async function openApp(){app=createApplication({dbPath,baseUrl:nativeOrigin,operatorToken:token,autoStart:false,streamEnabled:false});const port=await listen(app.server);await app.ready;productOrigin=`http://127.0.0.1:${port}`;csrf=(await product('/api/state')).csrfToken;}
try{
 runtime=spawn(resolve(binary),['serve','--bind',`127.0.0.1:${runtimePort}`,'--cwd',root,'--config-file',config,'--log-level','warn'],{cwd:root,env:{PATH:process.env.PATH,MORPHZ_HOME:join(root,'home'),MORPHZ_DASHBOARD_TOKEN:token,MORPHZ_PRINCIPAL_ID:'calendar-delivery-fixture',MORPHZ_STORAGE_SQLITE_PATH:join(root,'runtime.sqlite'),LANG:'C.UTF-8'},stdio:'ignore'});
 await wait(async()=>{try{return(await native('/api/session-io/capabilities')).enabled}catch{return false}},'Runtime startup',Date.now()+15000);
 await openApp();await product('/api/models/account',{accountId:'fixture'});const due=Math.ceil((Date.now()+15000)/60000)*60000,date=new Date(due).toISOString();
 const rule={intent:'Return the exact fixture reminder text '+marker+' as the ordinary assistant reply. Do not invoke any tools.',timeZone:'UTC',frequency:'daily',localTime:date.slice(11,16),startDate:date.slice(0,10),untilDate:date.slice(0,10),dst:{gap:'skip',overlap:'earlier'},missed:'skip_unsubmitted',resume:'skip_overdue_paused'};
 const preview=await product('/api/calendar-reminders/preview',{rule});const created=await product('/api/calendar-reminders',{rule,idempotencyKey:'calendar-delivery-fixture',confirmed:true,previewFingerprint:preview.previewFingerprint});binding=app.runtime.store.binding();assert.equal(created.occurrence.time.instant,new Date(due).toISOString());assert.equal(providerCalls,0);
 await app.close();app=undefined;assert.ok(Date.now()<due,'BFF closes before due time');console.log(JSON.stringify({stage:'waiting_for_native_due',due:new Date(due).toISOString(),bff:'closed'}));
 await wait(async()=>{const events=await observer.listEvents(binding.sessionId);return events.events?.some(e=>e.type==='output.committed'&&e.message?.content?.value?.text===marker)},'native committed delivery while BFF offline',due+25000);
 await openApp();await product('/api/refresh',{});let state=await product('/api/state');const matches=()=>state.messages.filter(m=>m.role==='assistant'&&m.text===marker);assert.equal(matches().length,1,'Recovered one committed assistant reminder');const messageId=matches()[0].id;
 await app.close();app=undefined;await openApp();await product('/api/refresh',{});state=await product('/api/state');assert.equal(matches().length,1);assert.equal(matches()[0].id,messageId);assert.equal(app.runtime.store.binding().sessionId,binding.sessionId);
 await product('/api/calendar-reminders/reconcile',{});const inventory=await product('/api/calendar-reminders');const series=inventory.series.find(s=>s.id===created.id);assert.ok(series);const history=await product(`/api/calendar-reminders/${created.id}/occurrences`);assert.ok(history.occurrences.some(o=>o.id===created.occurrence.id),'Original occurrence remains in durable history');
 assert.ok(modelAnswered);assert.equal(providerCalls,1,'BFF recovery must not start another inference');
 console.log(JSON.stringify({level:'L2',runtime:'unchanged official v0.1.3',dueTriggers:1,bffOfflineAtDue:true,committedReminderRecovered:true,restartSameMessage:true,model:'deterministic loopback',modelCalls:providerCalls,paidCalls:0,scriptedToolCalls:0}));
}finally{
 await app?.close();if(runtime?.pid&&runtime.exitCode===null&&runtime.signalCode===null){runtime.kill('SIGTERM');await new Promise(r=>{const timer=setTimeout(()=>runtime.kill('SIGKILL'),2000);runtime.once('close',()=>{clearTimeout(timer);r()})});}provider.closeAllConnections();await new Promise(r=>provider.close(r));rmSync(root,{recursive:true,force:true});
}
