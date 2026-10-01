import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeService } from '../src/runtime-service.ts';
import { RuntimeStore } from '../src/runtime-store.ts';
import { LocalOperatorAdapter, MorphzAdapter } from '../src/morphz-adapter.ts';
import { createApplication } from '../src/server.ts';

const capabilities = { enabled:true, directed_input:true, io_versions:['1'], encodings:['json'], formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}] };
function backend() {
  let session: any; let agent: any; let principal = 'actual-runtime-principal';
  const events: any[] = []; const inputs = new Map<string, any>(); const objectives = new Map<string, any>(); const approvals = new Map<string, any>();
  const calls: any[] = []; let loseMessage = false; let loseObjective = false;
  const fetcher = async (raw: any, init: any = {}) => {
    const url = new URL(raw); const path = decodeURIComponent(url.pathname); const method = init.method ?? 'GET';
    const input = init.body ? JSON.parse(init.body) : undefined; calls.push({path,method,input,headers:new Headers(init.headers),after:url.searchParams.get('after')});
    const ok = (value: unknown) => Response.json(value); const missing=()=>Response.json({error:{code:'not_found'}},{status:404});
    if(path==='/api/session-io/capabilities') return ok(capabilities);
    if(path==='/api/agents' && method==='GET') return ok({agents:agent?[agent]:[]});
    if(path==='/api/agents' && method==='POST') {
      agent={id:input.id,root_context_id:input.root_context_id};session={id:input.initial_session_id,context_id:input.root_context_id,agent_id:input.id,status:'active'};
      return ok({agent,root_context:{id:session.context_id},initial_session:session});
    }
    if(path===`/api/sessions/${session?.id}`)return session?ok(session):missing();
    if(path.endsWith('/principal'))return ok({principal_id:principal,session_id:session.id,context_id:session.context_id});
    if(path.includes('/overview'))return ok({context:{id:session.context_id,agent_id:session.agent_id},objectives:[...objectives.values()].filter(o=>!['completed','failed','cancelled'].includes(o.status)),sessions:[]});
    if(path.includes('/scheduler'))return ok({context_id:session.context_id,objectives:[...objectives.values()].map(objective=>({objective})),detail_bounds:{limit:2000,has_more_objectives:false}});
    if(path.endsWith('/io/events')) {
      const after=url.searchParams.get('after'); const index=after?Number(after.replace('fixture-cursor-','')):0;
      return ok({subscription:{io_version:'1'},events:events.slice(index),cursor:`fixture-cursor-${events.length}`});
    }
    if(path.endsWith('/io/messages')) {
      let receipt=inputs.get(input.client_message_id);
      const target=input.activation?.input_destination;
      if(!receipt && target) {const objective=objectives.get(target.objective_id);if(!objective||objective.generation!==target.generation||objective.status!=='active')return Response.json({error:{code:'objective_generation_conflict'}},{status:409});}
      if(!receipt){const event={io_version:'1',type:'input.accepted',event_id:`input-${inputs.size}`,sequence:events.length+1,session_id:session.id,timestamp:new Date().toISOString(),message:input.message};events.push(event);receipt={io_version:'1',status:'accepted',accepted:true,message_id:event.event_id,event_id:event.event_id,session_id:session.id,cursor:'MUST-NOT-BECOME-HISTORY-CURSOR',binding:{}};inputs.set(input.client_message_id,receipt);}
      if(loseMessage){loseMessage=false;throw new TypeError('simulated response loss');}return ok(receipt);
    }
    if(path==='/api/objectives'&&method==='POST'){
      if(objectives.has(input.id))return Response.json({error:{code:'conflict'}},{status:409});
      const objective={...input,agent_id:session.agent_id,context_id:session.context_id,status:'active',revision:1,generation:1};objectives.set(objective.id,objective);
      if(loseObjective){loseObjective=false;throw new TypeError('simulated response loss');}return ok({objective,harness_binding:null});
    }
    if(path.startsWith('/api/objectives/')){
      const [id,action] = path.slice('/api/objectives/'.length).split('/');const objective=objectives.get(id);if(!objective)return missing();
      if(objective.revision!==input.expected_revision)return Response.json({error:{code:'conflict'}},{status:409});
      objective.status=method==='DELETE'?'cancelled':action==='pause'?'paused':'active';objective.revision++;
      return method==='DELETE'?ok({deleted:true,objective_id:id,terminal_status:'cancelled'}):ok({objective});
    }
    if(path.endsWith('/approvals'))return ok({approvals:[...approvals.values()].filter(a=>a.status==='pending_human'),truncated:false});
    if(path.includes('/approvals/')){
      const id=path.split('/').at(-1)!;const approval=approvals.get(id);if(!approval)return missing();
      if(method==='POST'){if(input.expected_revision!==approval.revision)return Response.json({error:{code:'conflict'}},{status:409});approval.status=input.decision==='deny'?'denied':'approved';approval.revision++;}return ok(approval);
    }
    if(path.startsWith('/api/sessions/'))return missing();
    throw Error(`Unexpected fixture call ${method} ${path}`);
  };
  return { fetcher:fetcher as typeof fetch,calls,events,inputs,objectives,approvals,loseMessage:()=>{loseMessage=true;},loseObjective:()=>{loseObjective=true;},principal:(v:string)=>{principal=v;},clear:()=>{session=undefined;agent=undefined;} };
}
function pathFor(t: test.TestContext) { const root=mkdtempSync(join(tmpdir(),'opendots-bridge-test-'));t.after(()=>rmSync(root,{force:true,recursive:true}));return join(root,'product.db'); }
const configured = (dbPath:string,b:any) => new RuntimeService({dbPath,baseUrl:'http://127.0.0.1:56789',operatorToken:'fixture-only',fetch:b.fetcher,autoStart:false});

test('Runtime host bootstraps and persists exact local identity without asserting a principal',async t=>{
 const path=pathFor(t),b=backend();let service=configured(path,b);await service.refresh();
 assert.equal(service.status.status,'ready');const binding=service.store.binding()!;assert.equal(binding.principalId,'actual-runtime-principal');assert.equal(binding.verified,true);
 assert.ok(b.calls.every(c=>!c.headers.has('x-morphz-principal')));await service.close();
 service=configured(path,b);await service.refresh();assert.deepEqual(service.store.binding(),binding);assert.equal(b.calls.filter(c=>c.path==='/api/agents'&&c.method==='POST').length,1);await service.close();
});

test('lost chat receipt retries exact saved command after restart; receipt never advances history cursor',async t=>{
 const path=pathFor(t),b=backend();let service=configured(path,b);await service.refresh();const binding=service.store.binding()!;const before=service.store.cursor(binding.sessionId);b.loseMessage();
 await assert.rejects(service.sendChat('Real typed input','durable-chat-key'));assert.equal(service.store.commands()[0].status,'unknown');assert.equal(service.store.cursor(binding.sessionId),before);await service.close();
 service=configured(path,b);const retry=await service.sendChat('Real typed input','durable-chat-key');assert.equal(retry.status,'accepted');assert.equal(b.inputs.size,1);
 await assert.rejects(service.sendChat('Changed payload','durable-chat-key'),/Idempotency/);await service.refresh();assert.equal(service.snapshot().messages.length,1);assert.equal(service.snapshot().messages[0].text,'Real typed input');
 const writes=b.calls.filter(c=>c.path.endsWith('/io/messages'));assert.deepEqual(writes[0].input,writes[1].input);assert.ok(!b.calls.some(c=>c.after==='MUST-NOT-BECOME-HISTORY-CURSOR'));await service.close();
});

test('unknown Objective creation is reconciled by fixed ID instead of duplicated',async t=>{
 const path=pathFor(t),b=backend(),service=configured(path,b);await service.refresh();b.loseObjective();await assert.rejects(service.createObjective('Make a real artifact','durable-objective-key'));
 const recovered=await service.createObjective('Make a real artifact','durable-objective-key');assert.equal(recovered.status,'accepted');assert.equal(b.objectives.size,1);assert.equal(b.calls.filter(c=>c.path==='/api/objectives').length,1);
 assert.equal(service.snapshot().jobs[0].status,'active');await service.close();
});

test('Objective control and approval are real revision-checked Runtime writes, with exact ownership',async t=>{
 const path=pathFor(t),b=backend(),service=configured(path,b);await service.refresh();await service.createObjective('Do work','objective-for-control');
 const objective=service.snapshot().jobs[0];await service.controlObjective(objective.id,'pause',1,'pause-objective-key');assert.equal(b.objectives.get(objective.id).status,'paused');
 await assert.rejects(service.controlObjective('foreign-objective','cancel',1,'foreign-objective-key'),/not found/);
 b.approvals.set('approval-1',{id:'approval-1',revision:4,status:'pending_human',requested_scope:'once',available_scopes:['once'],requested:{write_paths:['/fixture']}});
 await assert.rejects(service.decideApproval('approval-1','allow_once',3,'stale-approval-key'));
 await service.decideApproval('approval-1','deny',4,'deny-approval-key');assert.equal(b.approvals.get('approval-1').status,'denied');await service.refresh();assert.equal(service.snapshot().approvals.length,0);await service.close();
});

test('a changed Runtime identity or missing previously verified Session fails closed',async t=>{
 const path=pathFor(t),b=backend();let service=configured(path,b);await service.refresh();await service.close();b.principal('other-principal');service=configured(path,b);await service.refresh();assert.equal(service.status.status,'configuration_required');assert.match(service.status.message,/identity/);await service.close();
 b.clear();service=configured(path,b);await service.refresh();assert.equal(service.status.status,'configuration_required');assert.equal(b.calls.filter(c=>c.path==='/api/agents'&&c.method==='POST').length,1);await service.close();
});

test('history ingestion and opaque checkpoint are atomic and reject foreign events or stale readers',t=>{
 const store=new RuntimeStore(pathFor(t));const event:any={io_version:'1',type:'output.committed',event_id:'e1',sequence:1,session_id:'s'};
 store.ingest('s',{subscription:{},events:[event],cursor:'opaque-a'});assert.equal(store.events('s').length,1);
 assert.throws(()=>store.ingest('s',{subscription:{},events:[{...event,event_id:'e2',sequence:2,session_id:'foreign'}],cursor:'opaque-b'},'opaque-a'));assert.equal(store.cursor('s'),'opaque-a');assert.equal(store.events('s').length,1);
 assert.throws(()=>store.ingest('s',{subscription:{},events:[],cursor:'old'},undefined),/cursor changed/);store.close();
});

test('operator and gateway adapters remain separate; operator refuses remote origins',()=>{
 assert.throws(()=>new LocalOperatorAdapter({baseUrl:'https://morphz.example',operatorToken:'secret'}),/loopback/);
 const gateway=new MorphzAdapter({baseUrl:'https://morphz.example',principalId:'user'});assert.equal('getContextOverview' in gateway,false);assert.equal('getProviders' in gateway,false);
});

test('default HTTP mode is real and visibly unconfigured, never falls back to simulated answers',async t=>{
 const app=createApplication({dbPath:pathFor(t),autoStart:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const address=app.server.address() as any;const origin=`http://127.0.0.1:${address.port}`;
 const state=await (await fetch(origin+'/api/state')).json();assert.equal(state.mode,'runtime');assert.equal(state.runtime.status,'configuration_required');assert.deepEqual(state.messages,[]);
 const post=(data:object)=>fetch(origin+'/api/chat',{method:'POST',headers:{'content-type':'application/json','x-opendots-csrf':state.csrfToken},body:JSON.stringify(data)});
 assert.equal((await post({text:'Hello',idempotencyKey:'unconfigured-chat'})).status,503);assert.equal((await post({text:'Hello',idempotencyKey:'unconfigured-chat',principalId:'admin'})).status,400);
 assert.equal((await fetch(origin+'/api/state?principal_id=admin')).status,400);
});


test('terminal Objective state is sourced from scheduler rather than active-only overview',async t=>{
 const path=pathFor(t),b=backend(),service=configured(path,b);await service.refresh();await service.createObjective('Finish a task','terminal-objective-key');
 const id=service.snapshot().jobs[0].id;const value=b.objectives.get(id);value.status='completed';value.revision=3;await service.refresh();
 assert.equal(service.snapshot().jobs[0].status,'completed');assert.equal(service.snapshot().jobs[0].revision,3);assert.ok(b.calls.some(c=>c.path.endsWith('/scheduler')));await service.close();
});


test('directed task input retries original admission after response loss and generation advance', async t => {
 const path=pathFor(t), b=backend(); let service=configured(path,b); await service.refresh();
 await service.createObjective('Keep working','task-input-objective');
 const objective=service.snapshot().jobs[0]; const target=await service.objectiveInputTarget(objective.id);
 assert.equal(target.available,true); assert.equal(target.generation,1);
 const input={text:'Add this exact constraint',idempotencyKey:'task-supplement-key',expectedGeneration:target.generation};
 b.loseMessage(); await assert.rejects(service.sendObjectiveInput(objective.id,input));
 assert.equal(service.store.commandByKey(input.idempotencyKey)!.status,'unknown');
 const original=b.calls.filter(c=>c.path.endsWith('/io/messages')).at(-1)!.input;
 assert.deepEqual(original.activation,{mode:'evaluate',dispatch_mode:'parallel',input_destination:{kind:'objective',objective_id:objective.id,generation:1}});
 await service.close(); b.objectives.get(objective.id).generation=2; b.objectives.get(objective.id).revision=2;
 service=configured(path,b); const result=await service.sendObjectiveInput(objective.id,input);
 assert.equal(result.status,'accepted'); assert.equal(b.inputs.size,1);
 const writes=b.calls.filter(c=>c.path.endsWith('/io/messages')); assert.deepEqual(writes.at(-1)!.input,original);
 const count=writes.length;
 await assert.rejects(service.sendObjectiveInput(objective.id,{...input,idempotencyKey:'new-stale-task-key'}),/generation changed/);
 assert.equal(b.calls.filter(c=>c.path.endsWith('/io/messages')).length,count);
 await assert.rejects(service.sendObjectiveInput(objective.id,{...input,text:'Changed'}),/different task input/);
 b.objectives.get(objective.id).status='completed';
 assert.equal((await service.sendObjectiveInput(objective.id,input)).id,result.id);
 assert.equal((await service.objectiveInputTarget(objective.id)).available,false);
 await service.close();
});
