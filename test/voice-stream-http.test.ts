import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../src/server.ts';
import {authDigest} from '../src/auth-config.ts';
import type {SpeechProvider} from '../src/voice-provider.ts';
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function fixture(t:test.TestContext,authenticated=true){
 const root=mkdtempSync(join(tmpdir(),'opendots-stream-http-')),authConfigPath=join(root,'auth.json'),credential='f'.repeat(64);let opens=0,closes=0;const writes:Uint8Array[]=[];let emit:(text:string,final:boolean)=>void=()=>{};
 writeFileSync(authConfigPath,JSON.stringify({version:1,credential:{kind:'morphz_login_token_sha256',hashHex:authDigest(credential)},sessionTtlSeconds:3600,idleTtlSeconds:60,maximumDevices:8}),{mode:0o600});
 const provider:SpeechProvider={provider:{id:'doubao',label:'fixture'},configured:()=>true,transcribe:async()=>'',synthesize:async()=>Buffer.alloc(0),openStream(principal,result){assert.equal(principal,'fixture-principal');opens++;emit=result;let closed!:()=>void;const promise=new Promise<void>(r=>closed=r);return{ready:Promise.resolve(),closed:promise,write(data){writes.push(data.slice());result('UNSENT_PARTIAL',false);},finish(){result('UNSENT_FINAL',true);},close(){closes++;closed();}};}};
 const app=createApplication({dbPath:join(root,'app.sqlite'),...(authenticated?{authConfigPath}:{}),baseUrl:'http://127.0.0.1:38889',fetch:async()=>{throw Error('No native invocation expected in this HTTP lifecycle fixture');},autoStart:false,voice:{enabled:true,provider}});
 // The fixture supplies the verified-context boundary; actual native identity is
 // exercised by the existing voice/resource Runtime tests, not this HTTP test.
 app.runtime!.voiceContext=async()=>({sessionId:app.runtime!.store.binding()!.sessionId,principalId:'fixture-principal',events:[]});
 await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));await app.ready;const origin=`http://127.0.0.1:${(app.server.address()as{port:number}).port}`;
 t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
 const login=async()=>{const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({credential,deviceLabel:'Fixture device'})});assert.equal(response.status,200);const body=await response.json();return{cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:body.session.csrfToken};};
 const post=(device:{cookie:string;csrf:string},input:any,signal?:AbortSignal)=>fetch(origin+'/api/voice/stream',{method:'POST',headers:{origin,cookie:device.cookie,'content-type':'application/json','x-opendots-csrf':device.csrf},body:JSON.stringify(input),signal});
 return{app,origin,login,post,writes,emit:(text:string,final=false)=>emit(text,final),opens:()=>opens,closes:()=>closes};
}

test('stream capability is config-only and ongoing dictation requires owner auth and separate consent',async t=>{
 const f=await fixture(t),device=await f.login(),id=randomUUID();const capability=await(await fetch(f.origin+'/api/voice',{headers:{cookie:device.cookie}})).json();assert.equal(capability.stream.available,true);assert.equal(capability.stream.duplex,false);assert.equal(capability.operations.streamingDictation,true);assert.equal(f.opens(),0);
 const helper=await fetch(f.origin+'/voice-stream-capture.js',{headers:{cookie:device.cookie}});assert.equal(helper.status,200);assert.match(helper.headers.get('content-type')!,/javascript/);assert.match(await helper.text(),/createVoiceStreamCapture/);assert.equal(f.opens(),0);
 assert.equal((await fetch(f.origin+'/api/voice/stream',{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify({id,action:'open',consent:true})})).status,401);
 assert.equal((await f.post({...device,csrf:'invalid'},{id,action:'open',consent:true})).status,403);
 assert.equal((await f.post(device,{id,action:'open',consent:false})).status,400);assert.equal(f.opens(),0);
 const local=await fixture(t,false),localState=await(await fetch(local.origin+'/api/state')).json();const localCapability=await(await fetch(local.origin+'/api/voice')).json();assert.equal(localCapability.operations.transcribe,true);assert.equal(localCapability.stream.available,false);assert.equal(localCapability.stream.unavailableReason,'owner_authentication_required');
 assert.equal((await local.post({cookie:'',csrf:localState.csrfToken},{id,action:'open',consent:true})).status,403);assert.equal(local.opens(),0);
});

test('stream HTTP frame bound, latest-frame deduplication, unsent partial/final and exact device scope',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login(),id=randomUUID();const open=await(await f.post(a,{id,action:'open',consent:true})).json();assert.equal(open.status,'listening');
 assert.equal((await f.post(b,{id,action:'read',after:-1})).status,403);assert.equal(f.closes(),0);
 const push={id,action:'push',sequence:1,data:Array(6400).fill(0)};const partial=await(await f.post(a,push)).json();assert.equal(partial.text,'UNSENT_PARTIAL');assert.equal(partial.sentToChat,false);assert.equal(partial.receivedSequence,1);
 assert.equal((await f.post(a,push)).status,200);assert.equal(f.writes.length,1);
 assert.equal((await f.post(a,{id,action:'push',sequence:2,data:Array(6402).fill(0)})).status,400);
 const final=await(await f.post(a,{id,action:'finish'})).json();assert.equal(final.status,'complete');assert.equal(final.text,'UNSENT_FINAL');assert.equal(final.reviewRequired,true);assert.equal(f.closes(),1);
 assert.equal(f.app.runtime!.store.commands().length,0);
 assert.equal(f.app.runtime!.store.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'voice_stream%'").all().length,0);
 const cancelled=await(await f.post(a,{id,action:'cancel'})).json();assert.equal(cancelled.text,'');
});

test('owner logout cancels exact provider immediately and stale commands cannot reopen it',async t=>{
 const f=await fixture(t),device=await f.login(),id=randomUUID();await f.post(device,{id,action:'open',consent:true});
 const logout=await fetch(f.origin+'/api/auth/logout',{method:'POST',headers:{origin:f.origin,cookie:device.cookie,'content-type':'application/json','x-opendots-csrf':device.csrf},body:'{}'});assert.equal(logout.status,200);assert.equal(f.closes(),1);
 assert.equal((await f.post(device,{id,action:'open',consent:true})).status,401);assert.equal(f.opens(),1);
});

test('transport interruption cancels long-poll provider and shutdown closes an active stream',async t=>{
 const f=await fixture(t),device=await f.login(),id=randomUUID();const open=await(await f.post(device,{id,action:'open',consent:true})).json();const abort=new AbortController();const read=f.post(device,{id,action:'read',after:open.revision},abort.signal);const rejected=assert.rejects(read);await new Promise(r=>setTimeout(r,30));abort.abort();await rejected;
 for(let i=0;i<50&&f.closes()===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.closes(),1);
 const next=randomUUID();await f.post(device,{id:next,action:'open',consent:true});await f.app.close();await tick();assert.equal(f.closes(),2);
});
