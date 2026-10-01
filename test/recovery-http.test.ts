/** Route-contract regression fixtures. These are not native Runtime proofs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.ts';
async function fixture(t:test.TestContext){
 const dir=mkdtempSync(join(tmpdir(),'opendots-recovery-http-'));
 const app=createApplication({dbPath:join(dir,'product.db'),autoStart:false});
 await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));await app.ready;
 const origin=`http://127.0.0.1:${(app.server.address() as any).port}`;
 const csrf=(await(await fetch(origin+'/api/state')).json()).csrfToken;
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const post=(path:string,body:unknown,token=csrf)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json','x-opendots-csrf':token},body:JSON.stringify(body)});
 return {app,origin,post};
}
test('task detail and exact command lookup use dedicated read routes',async t=>{
 const {app,origin}=await fixture(t);const calls:unknown[]=[];
 app.runtime!.taskDetail=async(id:string)=>{calls.push(id);return {objective:{id}} as any;};
 app.runtime!.commandLookup=(key:string)=>({authority:'local_command_ledger',userId:'owner',sessionId:'session',command:{key}} as any);
 assert.deepEqual(await(await fetch(origin+'/api/jobs/task-exact/detail')).json(),{objective:{id:'task-exact'}});
 assert.equal((await(await fetch(origin+'/api/commands/command-exact')).json()).command.key,'command-exact');
 assert.deepEqual(calls,['task-exact']);assert.equal((await fetch(origin+'/api/commands/short')).status,404);
});
test('history paging enforces bounded pages, strict fields, and csrf',async t=>{
 const {app,post}=await fixture(t);const calls:unknown[]=[];
 app.runtime!.messagesPage=(value:any)=>{calls.push(value);return {messages:[],messageHistory:{sessionId:'session',hasOlder:false,nextBefore:null}} as any;};
 assert.equal((await post('/api/messages/page',{before:'event-cursor',limit:20})).status,200);
 assert.deepEqual(calls,[{before:'event-cursor',limit:20}]);
 for(const body of [{limit:101},{limit:0},{limit:1.5},{sessionId:'other'},{before:''}])assert.equal((await post('/api/messages/page',body)).status,400);
 assert.equal((await post('/api/messages/page',{},'')).status,403);assert.equal(calls.length,1);
 assert.equal((await post('/api/messages/page',{before:'a'.repeat(800)})).status,200);
 assert.equal((await post('/api/messages/page',{before:'a'.repeat(1025)})).status,400);
});
test('wait response preserves explicit confirmation, exact Session and request identity',async t=>{
 const {app,post}=await fixture(t);const calls:any[]=[];
 app.runtime!.sendObjectiveInput=async(id:string,input:any)=>{calls.push({id,input});return {status:'accepted'} as any;};
 const body={text:'Exact reply',idempotencyKey:'wait-response-key',expectedGeneration:2,replyToRequestId:'request-exact',expectedSessionId:'session-exact',acknowledgeQuestionUnavailable:true};
 assert.equal((await post('/api/jobs/objective-exact/input',body)).status,202);
 assert.deepEqual(calls,[{id:'objective-exact',input:body}]);
 assert.equal((await post('/api/jobs/objective-exact/input',{...body,acknowledgeQuestionUnavailable:false})).status,400);
 assert.equal((await post('/api/jobs/objective-exact/input',{...body,principalId:'other'})).status,400);assert.equal(calls.length,1);
});
test('fresh task controls preserve predecessor and require literal uncertainty acknowledgement',async t=>{
 const {app,post}=await fixture(t);const calls:any[]=[];
 app.runtime!.controlObjective=async(...args:any[])=>{calls.push(args);return {status:'accepted'} as any;};
 const body={action:'pause',expectedRevision:9,idempotencyKey:'new-control-key',reviewedUnknownControlKey:'original-unknown-key',acknowledgeUncertainOutcome:true};
 assert.equal((await post('/api/jobs/task-exact/control',body)).status,200);
 assert.deepEqual(calls,[['task-exact','pause',9,'new-control-key',{reviewedUnknownControlKey:'original-unknown-key',acknowledgeUncertainOutcome:true}]]);
 assert.equal((await post('/api/jobs/task-exact/control',{...body,acknowledgeUncertainOutcome:'yes'})).status,400);
 assert.equal((await post('/api/jobs/task-exact/control',{...body,reviewedUnknownControlKey:'bad'})).status,400);assert.equal(calls.length,1);
});
