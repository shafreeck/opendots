import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ComputerApprovals } from '../src/computer-approvals.ts';
import type { ComputerEdgeBinding, ComputerExecutionScope, ComputerToolRequest } from '../src/computer-edge-types.ts';
const binding:ComputerEdgeBinding={nodeId:'node',targetId:'desktop',principalId:'principal',agentId:'agent',contextId:'context',sessionId:'session',policyDigest:'digest'};
const scope:ComputerExecutionScope={principal_id:'principal',agent_id:'agent',context_id:'context',session_id:'session',thread_id:'thread',objective_id:'objective'};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const observationId='11111111-1111-4111-8111-111111111111';
const text='sensitive-transient-text';
const request:Extract<ComputerToolRequest,{action:'act'}>={action:'act',epoch:7,observationId,operation:{type:'type',text}};
async function fixture(t:test.TestContext) {
 const db=new DatabaseSync(':memory:');let now=1000,authorized=true;const state={owner:'ai',epoch:7,leaseUntil:60000,uncertainty:false};
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=','base64');
 const options={db,binding,revalidate:async()=>{if(!authorized)throw Error('private authority error');},state:()=>state,now:()=>now,observation:()=>({observationId,epoch:7,display:{id:'display',width:1,height:1},capturedAt:999,sha256:sha(image),png:image})};
 const store=new ComputerApprovals(options);t.after(()=>{store.close();db.close();});
 const start=(jobId='job',signal=new AbortController().signal)=>{
   const promise=store.authorize(scope,request,{jobId,actionDigest:sha(JSON.stringify(request.operation)),signal,expiresAt:now+45000});
   // Capture failures immediately, so asynchronous deny/expiry never becomes an unhandled rejection.
   const outcome=promise.then(value=>({value}),error=>({error}));return outcome;
 };
 const pending=async()=>{for(let n=0;n<10;n++){const p=(await store.list()).approvals.find(a=>a.status==='pending');if(p)return p;await new Promise(r=>setImmediate(r));}throw Error('No pending approval');};
 return {db,store,options,state,start,pending,tick:(n:number)=>{now+=n;},denyAuthority:()=>{authorized=false;},image};
}
test('physical action waits for exact once-only user decision; durable journal omits text/image bytes',async t=>{
 const f=await fixture(t);const result=f.start();const pending=await f.pending();
 assert.equal(pending.action.text,text);assert.equal(pending.objectiveId,'objective');
 const stored=JSON.stringify(f.db.prepare('SELECT * FROM computer_action_approvals').all());assert.ok(!stored.includes(text));assert.ok(!stored.includes(f.image.toString('base64')));
 assert.deepEqual(await f.store.image(pending.id),f.image);
 await assert.rejects(f.store.decide(pending.id,'allow_once',pending.revision+1),/revision changed/);
 await f.store.decide(pending.id,'allow_once',pending.revision);
 const outcome=await result;assert.ok('value'in outcome&&outcome.value?.approved);if('value'in outcome){assert.equal(outcome.value?.epoch,7);assert.equal(outcome.value?.threadId,'thread');}
 await assert.rejects(f.store.decide(pending.id,'allow_once',pending.revision),/no longer pending/);
 await assert.rejects(f.store.image(pending.id),/no longer retained/);
 const summary=(await f.store.list()).approvals[0];assert.equal(summary.action.text,undefined);assert.equal(summary.status,'approved');
});
test('deny, abort and expiry cannot become an action permit',async t=>{
 const f=await fixture(t);let result=f.start('deny');let pending=await f.pending();await f.store.decide(pending.id,'deny',1);assert.ok('error'in await result);
 const abort=new AbortController();result=f.start('abort',abort.signal);await f.pending();abort.abort();assert.ok('error'in await result);
 result=f.start('expire');pending=await f.pending();f.tick(46000);await assert.rejects(f.store.decide(pending.id,'allow_once',1),/changed/);assert.ok('error'in await result);
});
test('current principal, native scope, observed action digest and control epoch are mandatory',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.store.authorize({...scope,principal_id:'foreign'},request,{jobId:'job',actionDigest:'wrong',signal:new AbortController().signal,expiresAt:10000}),/outside/);
 await assert.rejects(f.store.authorize(scope,request,{jobId:'job',actionDigest:'wrong',signal:new AbortController().signal,expiresAt:10000}),/identity/);
 const result=f.start();const pending=await f.pending();f.state.epoch++;f.state.owner='human';await assert.rejects(f.store.decide(pending.id,'allow_once',1),/changed/);assert.ok('error'in await result);
 f.denyAuthority();await assert.rejects(f.store.list(),/verify/);
});
test('process restart expires pending decisions; metadata cannot reconstruct a permission',async t=>{
 const f=await fixture(t);const result=f.start();const pending=await f.pending();f.store.close();assert.ok('error'in await result);
 // Simulate an unclean process loss in the durable row, without restoring ephemeral payload.
 f.db.prepare("UPDATE computer_action_approvals SET status='pending' WHERE id=?").run(pending.id);
 const resumed=new ComputerApprovals(f.options);try{const row=(await resumed.list()).approvals[0];assert.equal(row.status,'expired');assert.equal(row.actionable,false);assert.equal(row.imagePath,null);await assert.rejects(resumed.decide(row.id,'allow_once',row.revision),/no longer pending/);}finally{resumed.close();}
});
test('read-only requests revalidate identity but do not manufacture approvals',async t=>{
 const f=await fixture(t);assert.equal(await f.store.authorize(scope,{action:'observe',epoch:7},{jobId:'read',signal:new AbortController().signal,expiresAt:10000}),undefined);assert.equal((await f.store.list()).approvals.length,0);
});
