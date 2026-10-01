/** Deterministic projection tests; no provider/model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectTaskDetail,taskWait,type TaskDetailInput} from '../src/task-detail.ts';
import {RuntimeService} from '../src/runtime-service.ts';
import {LocalOperatorAdapter} from '../src/morphz-adapter.ts';
const binding={userId:'user',agentId:'agent',contextId:'context',sessionId:'session',principalId:'principal',verified:true,runtimeOrigin:'http://127.0.0.1:9000',createdAt:1};
const scoped={agent_id:'agent',context_id:'context',session_id:'session',initiating_principal_id:'principal'};
function sample():TaskDetailInput{
 const objective={id:'objective',agent_id:'agent',context_id:'context',coordinator_session_id:'session',delivery_session_id:'session',initiating_principal_id:'principal',stated_objective:'Write the requested report',status:'active',revision:3,generation:1};
 const thread={...scoped,id:'thread',root_turn_id:'root',revision:2,generation:1,kind:'execution',lifecycle:'open',control_state:'active',delivery_status:'delivered',supervision:{supervisor_kind:'objective',supervisor_id:'objective',generation:1}};
 const activation={...scoped,id:'activation',root_turn_id:'root',status:'running',generation:1};
 const job={...scoped,id:'job',activation_id:'activation',thread_id:'thread',tool_name:'host_opendots_documents',status:'succeeded',result_event_id:'tool-result',request:{secret:'DO-NOT-EXPOSE'}};
 return {binding,objective,scheduler:{context_id:'context',objectives:[{objective}],threads:[{thread,phase:'running',activations:[{activation,jobs:[{job}]}]}]},nativeEvents:[],ioEvents:[{io_version:'1',type:'output.committed',event_id:'delivery',sequence:1,session_id:'session',principal_id:'principal',thread_id:'thread',root_turn_id:'root',activation_id:'activation',message:{format:{id:'morphz.chat',version:'1'},content:{encoding:'json',value:{text:'Actual delivered report'}}}}],artifacts:[{id:'artifact',name:'report.txt',mediaType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64),sourceEventId:'delivery',origin:'output',createdAt:null,downloadable:true,downloadPath:'/api/artifacts/artifact/content'}]};
}
test('exact native Objective supervision exposes committed result and registered resources without claiming completion',()=>{
 const d=projectTaskDetail(sample());assert.equal(d.objective.status,'active');assert.equal(d.objective.terminal,false);assert.equal(d.deliveries[0].text,'Actual delivered report');assert.equal(d.deliveries[0].resources[0].sourceEventId,'delivery');assert.equal(d.threads[0].activations[0].jobs[0].id,'job');assert.ok(!JSON.stringify(d).includes('DO-NOT-EXPOSE'));
});
test('foreign Objective, Principal and unverified product binding fail closed',()=>{
 for(const change of [{agent_id:'foreign'},{context_id:'foreign'},{coordinator_session_id:'foreign'},{delivery_session_id:'foreign'},{initiating_principal_id:'foreign'}]){const x=sample();Object.assign(x.objective,change);assert.throws(()=>projectTaskDetail(x),/owner Session/);}
 const x=sample();x.binding={...binding,verified:false};assert.throws(()=>projectTaskDetail(x));
});
test('crossed thread/root pairs, unrelated latest replies and explicit conflicting metadata are excluded',()=>{
 for(const change of [{thread_id:'other'},{root_turn_id:'other'},{session_id:'other'},{principal_id:'other'}]){const x=sample();Object.assign(x.ioEvents[0],change);assert.equal(projectTaskDetail(x).deliveries.length,0);}
 const x=sample();x.nativeEvents=[{id:'delivery',payload:{session_id:'session',objective_id:'different-objective',thread_id:'thread',root_turn_id:'root'}}];assert.equal(projectTaskDetail(x).deliveries.length,0);
 x.nativeEvents=[{id:'delivery',payload:{session_id:'foreign',objective_id:'objective',thread_id:'thread',root_turn_id:'root'}}];assert.equal(projectTaskDetail(x).deliveries.length,0);
});
test('attached children require exact parent generation and same fixed Session',()=>{
 const x=sample(),parent=x.scheduler.threads[0];const child=structuredClone(parent);child.thread.id='child';child.thread.root_turn_id='child-root';child.thread.supervision={supervisor_kind:'thread',supervisor_id:'thread',parent_thread_id:'thread',generation:1,lifetime:'attached'};child.activations=[];x.scheduler.threads.push(child);assert.equal(projectTaskDetail(x).threads.length,2);child.thread.supervision.generation=2;assert.equal(projectTaskDetail(x).threads.length,1);child.thread.supervision.generation=1;child.thread.session_id='foreign';assert.equal(projectTaskDetail(x).threads.length,1);
});
test('creation Evaluation proof includes only exact activation jobs and excludes neighboring work on the same root',()=>{
 const x=sample(),thread=x.scheduler.threads[0];thread.thread.supervision={supervisor_kind:'none',generation:1};x.scheduler.objectives[0].active_evaluation=thread.activations[0].activation;const neighbor=structuredClone(thread.activations[0]);neighbor.activation.id='neighbor';neighbor.jobs[0].job.id='neighbor-job';neighbor.jobs[0].job.activation_id='neighbor';thread.activations.push(neighbor);let d=projectTaskDetail(x);assert.equal(d.threads[0].activations.length,1);assert.equal(d.deliveries.length,1);x.ioEvents[0].activation_id='neighbor';assert.equal(projectTaskDetail(x).deliveries.length,0);
 x.scheduler.objectives[0].active_evaluation=null;x.nativeEvents=[{id:'proof',topic:'objective/continued',payload:{session_id:'session',context_id:'context',objective_id:'objective',objective_evaluation_id:'evaluation',activation_id:'activation'}}];x.ioEvents[0].activation_id='activation';d=projectTaskDetail(x);assert.equal(d.deliveries.length,1);x.nativeEvents=[];assert.equal(projectTaskDetail({...x,previous:d}).deliveries.length,1);
});
test('pending approvals require exact same-scope Job and expose only safe summaries',()=>{
 const x=sample(),entry=x.scheduler.threads[0].activations[0].jobs[0];entry.approval={id:'approval',revision:4,job_id:'job',status:'pending_human',action:{secret:'ACTION-SECRET'},requested:{secret:'REQUEST-SECRET'}};let d=projectTaskDetail(x);assert.equal(d.approvals[0].id,'approval');assert.ok(!JSON.stringify(d).includes('SECRET'));entry.approval.job_id='other';assert.equal(projectTaskDetail(x).approvals.length,0);entry.approval.job_id='job';entry.job.session_id='foreign';assert.equal(projectTaskDetail(x).approvals.length,0);
});
test('typed waits use whitelist labels and never reconstruct question content from arbitrary text',()=>{
 for(const kind of ['tool_task','delegation','thread_group','timer','permission','user_input','external_event','resource_available'])assert.equal(taskWait({kind,question:'INVENTED',resource:'SECRET'})!.kind,kind);assert.equal(taskWait({kind:'user_input',question:'INVENTED'})!.questionText,null);assert.ok(!JSON.stringify(taskWait({kind:'resource_available',resource:'SECRET'})).includes('SECRET'));assert.equal(taskWait({kind:'hostile'})!.kind,'unknown');
});
test('immutable cached deliveries survive bounded windows; regressed native revisions cannot replace current task state',()=>{
 const x=sample();x.objective.status='completed';const first=projectTaskDetail(x);x.ioEvents=[];x.scheduler.threads=[];x.objective={...x.objective,status:'active',revision:2};const next=projectTaskDetail({...x,previous:first});assert.equal(next.deliveries.length,1);assert.equal(next.objective.status,'completed');assert.equal(next.freshness.fresh,false);assert.equal(next.unassociatedResources,0);
});
test('immutable delivery rewrite is rejected and bounded sources disclose incomplete evidence',()=>{
 const x=sample(),previous=projectTaskDetail(x);(x.ioEvents[0].message!.content.value as any).text='rewritten';assert.throws(()=>projectTaskDetail({...x,previous}),/Immutable/);x.scheduler.detail_bounds={has_more_threads:true,has_more_jobs:true};const d=projectTaskDetail(x);assert.equal(d.bounds.incomplete,true);assert.deepEqual(d.bounds.reasons,['has_more_threads','has_more_jobs']);
});
test('task history deduplicates immutable event IDs and omits raw rationale or payloads',()=>{
 const x=sample();x.nativeEvents=[{id:'status',topic:'objective/completed',timestamp:'2026-10-01T00:00:00Z',payload:{session_id:'session',objective_id:'objective',status:'completed',reason:'PRIVATE-REASON',request:'PRIVATE-REQUEST'}}];const d=projectTaskDetail(x);assert.equal(d.history.length,1);assert.ok(!JSON.stringify(d).includes('PRIVATE-'));assert.equal(projectTaskDetail({...x,previous:d}).history.length,1);
});
test('native Event read uses supported fixed Session GET and refuses an oversized response before decoding',async()=>{
 let cancelled=false;const adapter=new LocalOperatorAdapter({baseUrl:'http://127.0.0.1:9000',fetch:async(url,init)=>{assert.equal(String(url),'http://127.0.0.1:9000/api/sessions/session/events?limit=1000');assert.equal(init!.method,'GET');return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'3000000'}});}});await assert.rejects(adapter.getNativeSessionEvents('session'));assert.equal(cancelled,true);
});
test('service coalesces exact task reads and retains scoped cached result after host restart offline',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'task-detail-service-')),path=join(dir,'db');t.after(()=>rmSync(dir,{recursive:true,force:true}));let s:RuntimeService,offline=false,reads=0;const caps={enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]};const fetcher:typeof fetch=async raw=>{if(offline)throw new TypeError('offline');const p=new URL(String(raw)).pathname,b=s.store.binding()!,o={...sample().objective,agent_id:b.agentId,context_id:b.contextId,coordinator_session_id:b.sessionId,delivery_session_id:b.sessionId};if(p.endsWith('/capabilities'))return Response.json(caps);if(p===`/api/sessions/${b.sessionId}`)return Response.json({id:b.sessionId,agent_id:b.agentId,context_id:b.contextId});if(p.endsWith('/principal'))return Response.json({principal_id:'principal',session_id:b.sessionId,context_id:b.contextId});if(p.endsWith('/overview'))return Response.json({context:{id:b.contextId,agent_id:b.agentId},objectives:[o],sessions:[]});if(p.endsWith('/scheduler'))return Response.json({context_id:b.contextId,objectives:[{objective:o}],threads:[],detail_bounds:{limit:2000,has_more_objectives:false}});if(p.endsWith('/io/events'))return Response.json({events:[],cursor:'cursor',subscription:{}});if(p.endsWith('/events')){reads++;return Response.json({events:[],next_before_sequence:null});}if(p.endsWith('/approvals'))return Response.json({approvals:[],truncated:false});throw new Error('Unexpected '+p);};
 s=new RuntimeService({dbPath:path,baseUrl:'http://127.0.0.1:9000',fetch:fetcher,autoStart:false});const [first,second]=await Promise.all([s.taskDetail('objective'),s.taskDetail('objective')]);assert.deepEqual(first,second);assert.equal(reads,1);assert.equal(first.freshness.fresh,true);await s.close();offline=true;s=new RuntimeService({dbPath:path,baseUrl:'http://127.0.0.1:9000',fetch:fetcher,autoStart:false});const cached=await s.taskDetail('objective');assert.equal(cached.objective.id,'objective');assert.equal(cached.freshness.fresh,false);assert.deepEqual(cached.authoredDocuments,{items:[],truncated:false});await s.close();
});

test('a stale pending approval list cannot revive a newer resolved exact Job approval',()=>{
 const x=sample(),entry=x.scheduler.threads[0].activations[0].jobs[0];entry.approval={id:'approval',job_id:'job',revision:5,status:'approved'};x.approvals=[{id:'approval',job_id:'job',revision:4,status:'pending_human'}];assert.equal(projectTaskDetail(x).approvals.length,0);x.approvals[0].revision=5;assert.equal(projectTaskDetail(x).approvals.length,0);x.approvals[0].revision=6;assert.equal(projectTaskDetail(x).approvals[0].revision,6);
});
