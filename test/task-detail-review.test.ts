/** Independent reconstruction review. Fixtures cover native scope contradictions and stale evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectTaskDetail,type TaskDetailInput} from '../src/task-detail.ts';
import {RuntimeService} from '../src/runtime-service.ts';
const binding={userId:'owner',agentId:'agent',contextId:'context',sessionId:'session',principalId:'principal',verified:true,runtimeOrigin:'http://127.0.0.1:9901',createdAt:1};
const scope={agent_id:'agent',context_id:'context',session_id:'session',initiating_principal_id:'principal'};
function fixture():TaskDetailInput{
 const objective={id:'objective',agent_id:'agent',context_id:'context',coordinator_session_id:'session',delivery_session_id:'session',initiating_principal_id:'principal',stated_objective:'Requested result',status:'active',revision:7,generation:3};
 const activation={...scope,id:'activation',generation:2,root_turn_id:'root',status:'succeeded'};
 const job={...scope,id:'job',thread_id:'thread',activation_id:'activation',tool_name:'host_opendots_documents',status:'succeeded'};
 const thread={...scope,id:'thread',generation:2,revision:5,root_turn_id:'root',kind:'execution',lifecycle:'closed',control_state:'active',delivery_status:'delivered',supervision:{supervisor_kind:'objective',supervisor_id:'objective',generation:3,lifetime:'durable'}};
 return {binding:{...binding},objective,scheduler:{context_id:'context',objectives:[{objective}],threads:[{thread,phase:'closed',activations:[{activation,jobs:[{job}]}]}]},nativeEvents:[],ioEvents:[{io_version:'1',type:'output.committed',event_id:'output',sequence:1,session_id:'session',thread_id:'thread',activation_id:'activation',root_turn_id:'root',message:{format:{id:'morphz.chat',version:'1'},content:{encoding:'utf8',text:'Immutable result'}}}],artifacts:[]};
}
function nativeOutput(extra:Record<string,unknown>={}){return {id:'output',topic:'assistant/output',payload:{session_id:'session',context_id:'context',principal_id:'principal',objective_id:'objective',thread_id:'thread',root_turn_id:'root',activation_id:'activation',...extra}};}

test('review: native Objective lifecycle history uses actual objective_status DTO',()=>{
 const x=fixture();x.nativeEvents=[{id:'state-1',topic:'objective/completed',payload:{session_id:'session',context_id:'context',objective_id:'objective',objective_status:'completed',reason:'PRIVATE'}}];const d=projectTaskDetail(x);assert.equal(d.history[0].status,'completed');assert.ok(!JSON.stringify(d.history).includes('PRIVATE'));
});
test('review: contradictory typed/native activation routes never attribute a delivery',()=>{
 const x=fixture();x.nativeEvents=[nativeOutput({activation_id:'different-activation'})];assert.equal(projectTaskDetail(x).deliveries.length,0);
 x.nativeEvents=[nativeOutput()];assert.equal(projectTaskDetail(x).deliveries.length,1);
});
test('review: foreign native Principal or Context cannot borrow a same-session typed output',()=>{
 for(const field of ['principal_id','context_id','session_id']){const x=fixture();x.nativeEvents=[nativeOutput({[field]:'foreign'})];assert.equal(projectTaskDetail(x).deliveries.length,0);}
});
test('review: generation-invalid activations cannot expose their jobs or establish evaluation anchors',()=>{
 for(const generation of [0,-1,3,1.5]){const x=fixture();x.scheduler.threads[0].activations[0].activation.generation=generation;assert.equal(projectTaskDetail(x).threads[0].activations.length,0);x.scheduler.threads[0].thread.supervision={supervisor_kind:'none'};x.scheduler.objectives[0].active_evaluation=x.scheduler.threads[0].activations[0].activation;assert.equal(projectTaskDetail(x).threads.length,0);}
});
test('review: exact evaluation association never expands to adjacent same-root activation deliveries',()=>{
 const x=fixture(),s=x.scheduler.threads[0];s.thread.supervision={supervisor_kind:'none'};x.scheduler.objectives[0].active_evaluation=s.activations[0].activation;const adjacent=structuredClone(s.activations[0]);adjacent.activation.id='adjacent';adjacent.jobs[0].job.id='adjacent-job';adjacent.jobs[0].job.activation_id='adjacent';s.activations.push(adjacent);x.ioEvents.push({...x.ioEvents[0],event_id:'adjacent-output',sequence:2,activation_id:'adjacent'});const d=projectTaskDetail(x);assert.deepEqual(d.deliveries.map(e=>e.eventId),['output']);assert.deepEqual(d.threads[0].activations.flatMap((a:any)=>a.jobs.map((j:any)=>j.id)),['job']);
});
test('review: stale objective generation cannot become fresh merely because revision increased',()=>{
 const x=fixture(),previous=projectTaskDetail(x);x.objective={...x.objective,revision:8,generation:2,status:'paused'};const d=projectTaskDetail({...x,previous});assert.equal(d.freshness.fresh,false);assert.equal(d.objective.generation,3);assert.equal(d.objective.status,'active');assert.equal(d.bounds.incomplete,true);
});
test('review: scoped job fields are checked independently of a valid surrounding activation',()=>{
 for(const change of [{session_id:'foreign'},{context_id:'foreign'},{agent_id:'foreign'},{initiating_principal_id:'foreign'},{thread_id:'foreign'},{activation_id:'foreign'}]){const x=fixture();Object.assign(x.scheduler.threads[0].activations[0].jobs[0].job,change);assert.equal(projectTaskDetail(x).threads[0].activations[0].jobs.length,0);}
});
test('review: a thread supervised by another objective cannot be adopted by incidental activation events',()=>{
 const x=fixture();x.scheduler.threads[0].thread.supervision.supervisor_id='other-objective';x.nativeEvents=[{id:'anchor',payload:{session_id:'session',objective_id:'objective',activation_id:'activation'}}];assert.equal(projectTaskDetail(x).threads.length,0);assert.equal(projectTaskDetail(x).deliveries.length,0);
});
test('review: exact event resource joins exclude inputs and unrelated outputs',()=>{
 const x=fixture();const resource={id:'owned-resource',name:'answer.txt',mediaType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64),sourceEventId:'output',origin:'output' as const,createdAt:null,downloadable:true,downloadPath:'/api/artifacts/owned-resource/content'};x.artifacts=[resource,{...resource,id:'foreign-output',sourceEventId:'foreign-event'},{...resource,id:'input-file',origin:'input'}];const d=projectTaskDetail(x);assert.deepEqual(d.deliveries[0].resources.map(a=>a.id),['owned-resource']);assert.equal(d.unassociatedResources,1);
});
test('review: task detail truncation explicitly discloses thread, activation and job bounds',()=>{
 const x=fixture(),s=x.scheduler.threads[0];s.activations[0].jobs=Array.from({length:201},(_,i)=>({job:{...s.activations[0].jobs[0].job,id:'job-'+i}}));s.activations=Array.from({length:201},(_,i)=>({...s.activations[0],activation:{...s.activations[0].activation,id:'activation-'+i}}));x.scheduler.threads=Array.from({length:101},(_,i)=>({...s,thread:{...s.thread,id:'thread-'+i}}));const d=projectTaskDetail(x);assert.equal(d.threads.length,100);assert.equal(d.bounds.incomplete,true);for(const reason of ['threads_detail_limit','activations_detail_limit','jobs_detail_limit'])assert.ok(d.bounds.reasons.includes(reason));
});

async function serviceFixture(t:test.TestContext){
 const dir=mkdtempSync(join(tmpdir(),'task-detail-review-'));let service:RuntimeService;let offline=false,denied=false,missing=false,focused='good',manyJobs=false;let holdFocused:((resume:()=>void)=>void)|null=null;
 const capabilities={enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]};
 const fetcher:typeof fetch=async(raw)=>{
  if(offline)throw new TypeError('offline');const p=new URL(String(raw)).pathname,b=service.store.binding()!;
  const x=fixture(),sc={agent_id:b.agentId,context_id:b.contextId,session_id:b.sessionId,initiating_principal_id:'principal'};Object.assign(x.objective,{agent_id:b.agentId,context_id:b.contextId,coordinator_session_id:b.sessionId,delivery_session_id:b.sessionId});const s=x.scheduler.threads[0];Object.assign(s.thread,sc);Object.assign(s.activations[0].activation,sc);Object.assign(s.activations[0].jobs[0].job,sc);if(manyJobs){const original=s.activations[0];s.activations=Array.from({length:11},(_,i)=>({activation:{...original.activation,id:'activation-'+i},jobs:Array.from({length:i===10?1:200},(_,j)=>({job:{...original.jobs[0].job,id:'job-'+i+'-'+j,activation_id:'activation-'+i}}))}));}
  if(p.endsWith('/capabilities'))return Response.json(capabilities);
  if(p===`/api/sessions/${b.sessionId}`)return Response.json({id:b.sessionId,agent_id:b.agentId,context_id:b.contextId});
  if(p.endsWith('/principal'))return denied?Response.json({error:{message:'forbidden'}},{status:403}):Response.json({principal_id:'principal',session_id:b.sessionId,context_id:b.contextId});
  if(p.endsWith('/overview'))return Response.json({context:{id:b.contextId,agent_id:b.agentId},objectives:missing?[]:[x.objective],sessions:[]});
  if(p.endsWith('/scheduler'))return Response.json({context_id:b.contextId,objectives:missing?[]:[{objective:x.objective}],threads:[s],detail_bounds:{limit:2000,has_more_objectives:missing}});
  if(p.endsWith('/io/events'))return Response.json({events:[],cursor:'fixed',subscription:{}});
  if(p.endsWith('/events'))return Response.json({events:[],next_before_sequence:12});
  if(p.endsWith('/approvals'))return Response.json({approvals:[],truncated:false});
  if(p.endsWith('/threads/thread')){if(holdFocused)await new Promise<void>(resolve=>holdFocused!(resolve));if(focused==='unavailable')throw new TypeError('focused offline');return Response.json({context_id:focused==='foreign'?'foreign':b.contextId,snapshot:s});}
  throw new Error('Unexpected read '+p);
 };
 service=new RuntimeService({dbPath:join(dir,'product.db'),baseUrl:'http://127.0.0.1:9901',fetch:fetcher,autoStart:false});
 t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
 return {service,setManyJobs:(v:boolean)=>{manyJobs=v;},setOffline:(v:boolean)=>{offline=v;},setDenied:(v:boolean)=>{denied=v;},setMissing:(v:boolean)=>{missing=v;},setFocused:(v:string)=>{focused=v;},holdFocused:(fn:((resume:()=>void)=>void)|null)=>{holdFocused=fn;}};
}
test('review: native auth denial never exposes cached task detail as offline fallback',async t=>{
 const f=await serviceFixture(t);await f.service.taskDetail('objective');f.setDenied(true);await assert.rejects(f.service.taskDetail('objective'));assert.equal(f.service.store.views<any>('task_detail')[0].objective.id,'objective');
});
test('review: a focused thread scope contradiction fails closed even when valid cached evidence exists',async t=>{
 const f=await serviceFixture(t);await f.service.taskDetail('objective');f.setFocused('foreign');await assert.rejects(f.service.taskDetail('objective'),/scope changed/);
});
test('review: unavailable focused reads disclose incomplete evidence but preserve exact scheduler scope',async t=>{
 const f=await serviceFixture(t);f.setFocused('unavailable');const d=await f.service.taskDetail('objective');assert.equal(d.objective.id,'objective');assert.equal(d.freshness.fresh,true);assert.ok(d.bounds.reasons.includes('focused_thread_unavailable'));assert.ok(d.bounds.reasons.includes('native_history_window'));assert.equal(d.threads[0].id,'thread');
});
test('review: bounded scheduler omission and Runtime outage return cached task with controls stale',async t=>{
 const f=await serviceFixture(t);const original=await f.service.taskDetail('objective');f.setMissing(true);const absent=await f.service.taskDetail('objective');assert.equal(absent.objective.revision,original.objective.revision);assert.equal(absent.freshness.fresh,false);f.setOffline(true);const offline=await f.service.taskDetail('objective');assert.equal(offline.freshness.fresh,false);assert.equal(offline.bounds.incomplete,true);
});
test('review: revoked request authorization discards a late focused response rather than returning private cache',async t=>{
 const f=await serviceFixture(t);await f.service.taskDetail('objective');let authorized=true;let resume!:()=>void;let reached!:()=>void;const barrier=new Promise<void>(resolve=>reached=resolve);f.holdFocused(fn=>{resume=fn;reached();});const pending=f.service.withRequestAuthorization(()=>{if(!authorized)throw new Error('owner revoked');},()=>f.service.taskDetail('objective'));await barrier;authorized=false;resume();await assert.rejects(pending,/owner revoked/);
});

test('review: authored lookup caps many exact jobs without failing the whole task detail',async t=>{
 const f=await serviceFixture(t);f.setManyJobs(true);const d=await f.service.taskDetail('objective');assert.equal(d.freshness.fresh,true);assert.ok(d.bounds.reasons.includes('authored_job_lookup_limit'));assert.deepEqual(d.authoredDocuments,{items:[],truncated:true});assert.equal(d.threads[0].activations.flatMap((a:any)=>a.jobs).length,2001);
});
test('review: newer terminal scheduler approval cannot be replaced by stale pending inventory',()=>{
 const x=fixture();x.scheduler.threads[0].activations[0].jobs[0].approval={id:'approval',job_id:'job',revision:5,status:'approved'};x.approvals=[{id:'approval',job_id:'job',revision:4,status:'pending_human'} as any];assert.equal(projectTaskDetail(x).approvals.length,0);
});
