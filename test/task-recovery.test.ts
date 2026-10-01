import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeService} from '../src/runtime-service.ts';
import {RuntimeStore} from '../src/runtime-store.ts';
import {ObjectiveInput} from '../src/objective-input.ts';
function file(t:test.TestContext){const dir=mkdtempSync(join(tmpdir(),'opendots-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'data.db');}
const capabilities={enabled:true,directed_input:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]};
function backend(){
 let session:any;const objectives=new Map<string,any>(),approvals=new Map<string,any>(),inputs=new Map<string,any>(),calls:any[]=[];let lose='',offline=false;
 const fetcher:typeof fetch=async(raw,init={})=>{if(offline)throw new TypeError('offline');const u=new URL(String(raw)),p=decodeURIComponent(u.pathname),method=init.method||'GET',body=init.body?JSON.parse(String(init.body)):null;calls.push({p,method,body});const ok=(x:any)=>Response.json(x),conflict=()=>Response.json({error:{code:'revision_conflict'}},{status:409});
 if(p==='/api/session-io/capabilities')return ok(capabilities);
 if(p==='/api/agents'&&method==='GET')return ok({agents:[]});
 if(p==='/api/agents'&&method==='POST'){session={id:body.initial_session_id,agent_id:body.id,context_id:body.root_context_id,status:'active'};return ok({agent:{id:body.id},initial_session:session});}
 if(p===`/api/sessions/${session?.id}`)return ok(session);
 if(p.endsWith('/principal'))return ok({principal_id:'principal',session_id:session.id,context_id:session.context_id});
 if(p.endsWith('/overview'))return ok({context:{id:session.context_id,agent_id:session.agent_id},objectives:[...objectives.values()],sessions:[]});
 if(p.endsWith('/scheduler'))return ok({context_id:session.context_id,objectives:[...objectives.values()].map(objective=>({objective})),threads:[],detail_bounds:{limit:2000,has_more_objectives:false}});
 if(p.endsWith('/io/events'))return ok({events:[],cursor:'same-cursor',subscription:{}});
 if(p.endsWith('/approvals'))return ok({approvals:[...approvals.values()],truncated:false});
 if(p.includes('/approvals/')){const a=approvals.get(p.split('/').at(-1)!);if(!a)return new Response('',{status:404});if(method==='POST'){if(a.revision!==body.expected_revision)return conflict();a.revision++;a.status=body.decision==='deny'?'denied':'approved';if(lose==='approval'){lose='';throw new TypeError('lost');}}return ok(a);}
 if(p==='/api/objectives'&&method==='POST'){const o={...body,agent_id:session.agent_id,context_id:session.context_id,initiating_principal_id:'principal',status:'active',revision:1,generation:1};objectives.set(o.id,o);return ok({objective:o});}
 if(p.startsWith('/api/objectives/')&&method!=='GET'){const [id,action]=p.slice('/api/objectives/'.length).split('/'),o=objectives.get(id);if(!o||o.revision!==body.expected_revision)return conflict();o.revision++;o.status=method==='DELETE'?'cancelled':action==='pause'?'paused':'active';if(lose==='control'){lose='';throw new TypeError('lost');}return ok({objective:o});}
 if(p.endsWith('/io/messages')){const d=body.activation.input_destination;let receipt=inputs.get(body.client_message_id);if(!receipt){const o=objectives.get(d.objective_id);if(o.generation!==d.generation||o.wait_condition?.request_id!==d.reply_to_request_id||o.status!=='active')return conflict();receipt={io_version:'1',session_id:session.id,status:'accepted',accepted:true,event_id:'event-'+inputs.size,message_id:'message',cursor:'receipt-only',binding:{}};inputs.set(body.client_message_id,receipt);}if(lose==='input'){lose='';throw new TypeError('lost');}return ok(receipt);}
 return new Response('',{status:404});};
 return {fetcher,objectives,approvals,inputs,calls,lose:(kind:string)=>{lose=kind;},offline:(v:boolean)=>{offline=v;}};
}
const service=(path:string,b:ReturnType<typeof backend>)=>new RuntimeService({dbPath:path,baseUrl:'http://127.0.0.1:9911',fetch:b.fetcher,autoStart:false});
test('response-lost task control stays unknown after stale retry and host restart; replacement without review blocks',async t=>{
 const path=file(t),b=backend();let s=service(path,b);await s.refresh();await s.createObjective('Task','create-task-original');const o=s.store.objectives()[0];b.lose('control');await assert.rejects(s.controlObjective(o.id,'pause',1,'unknown-task-control'));assert.equal(s.store.commandByKey('unknown-task-control')!.status,'unknown');
 await assert.rejects(s.controlObjective(o.id,'pause',1,'unknown-task-control'));assert.equal(s.store.commandByKey('unknown-task-control')!.status,'unknown');await assert.rejects(s.controlObjective(o.id,'resume',2,'replacement-without-review'),/unresolved/);await s.close();s=service(path,b);assert.equal(s.commandLookup('unknown-task-control').command!.status,'unknown');await s.close();
});
test('fresh authoritative control requires advanced revision and persists one exact predecessor/successor chain',async t=>{
 const path=file(t),b=backend();let s=service(path,b);await s.refresh();await s.createObjective('Task','create-task-original');const o=s.store.objectives()[0];b.lose('control');await assert.rejects(s.controlObjective(o.id,'pause',1,'unknown-task-control'));
 const review={reviewedUnknownControlKey:'unknown-task-control',acknowledgeUncertainOutcome:true};await assert.rejects(s.controlObjective(o.id,'resume',1,'not-advanced-control',review));await assert.rejects(s.controlObjective(o.id,'resume',2,'missing-ack-control',{reviewedUnknownControlKey:'unknown-task-control'}));
 const next=await s.controlObjective(o.id,'resume',2,'reviewed-new-control',review);assert.equal(next.status,'accepted');assert.equal(s.commandLookup('unknown-task-control').command!.status,'unknown');assert.equal(s.commandLookup('unknown-task-control').command!.laterControlReview!.key,'reviewed-new-control');const count=b.calls.filter(c=>c.p.startsWith('/api/objectives/')&&c.method!=='GET').length;
 await assert.rejects(s.controlObjective(o.id,'pause',1,'unknown-task-control'),/later reviewed/);assert.equal((await s.controlObjective(o.id,'resume',2,'reviewed-new-control',review)).id,next.id);assert.equal(b.calls.filter(c=>c.p.startsWith('/api/objectives/')&&c.method!=='GET').length,count);
 await assert.rejects(s.controlObjective(o.id,'pause',3,'duplicate-successor-control',review),/later control/);await s.close();s=service(path,b);assert.equal(s.commandLookup('unknown-task-control').command!.laterControlReview!.key,next.key);assert.equal(s.commandLookup(next.key).command!.payload.reviewedUnknownControlKey,'unknown-task-control');await s.close();
});
test('approval lost decision remains unknown and blocks opposite decision even after Runtime resolves it',async t=>{
 const path=file(t),b=backend();let s=service(path,b);await s.refresh();b.approvals.set('approval',{id:'approval',status:'pending_human',revision:1,available_scopes:['once']});b.lose('approval');await assert.rejects(s.decideApproval('approval','allow_once',1,'unknown-approval-key'));await assert.rejects(s.decideApproval('approval','allow_once',1,'unknown-approval-key'));assert.equal(s.commandLookup('unknown-approval-key').command!.status,'unknown');await assert.rejects(s.decideApproval('approval','deny',2,'opposite-approval-key'),/unresolved/);await s.close();s=service(path,b);await assert.rejects(s.decideApproval('approval','deny',2,'opposite-after-restart'),/unresolved/);await s.close();
});
test('exact waiting request input requires acknowledgement and Session; same key preserves old target after newer wait',async t=>{
 const path=file(t),b=backend();let s=service(path,b);await s.refresh();await s.createObjective('Task','create-task-original');const o=b.objectives.values().next().value!;o.wait_condition={kind:'user_input',session_id:s.store.binding()!.sessionId,request_id:'wait-one'};const target=await s.objectiveInputTarget(o.id);assert.equal(target.waitInputAvailable,true);assert.equal(target.questionText,null);
 const input={text:'Same exact answer',idempotencyKey:'wait-answer-original',expectedGeneration:1,replyToRequestId:'wait-one',expectedSessionId:target.sessionId,acknowledgeQuestionUnavailable:true};await assert.rejects(s.sendObjectiveInput(o.id,{...input,expectedSessionId:'other-session'}),/Session/);await assert.rejects(s.sendObjectiveInput(o.id,{...input,acknowledgeQuestionUnavailable:undefined}),/question content/);
 b.lose('input');await assert.rejects(s.sendObjectiveInput(o.id,input));await s.close();o.wait_condition.request_id='wait-two';o.generation=2;o.revision=3;s=service(path,b);assert.equal((await s.sendObjectiveInput(o.id,input)).status,'accepted');assert.equal(b.inputs.size,1);const writes=b.calls.filter(c=>c.p.endsWith('/io/messages'));assert.deepEqual(writes[0].body,writes[1].body);await assert.rejects(s.sendObjectiveInput(o.id,{...input,idempotencyKey:'new-key-old-wait'}),/generation changed/);await s.close();
});
test('newest 100 messages and Session-scoped older/gap pages leave opaque native checkpoint untouched',t=>{
 const s=new RuntimeStore(file(t)),b=s.ensureBinding('http://127.0.0.1:9911');const rows=Array.from({length:251},(_,i)=>({io_version:'1' as const,type:i%2?'output.committed':'input.accepted',event_id:'e'+i,session_id:b.sessionId,sequence:i+1,message:{format:{id:'morphz.chat',version:'1'},content:{encoding:'json',value:{text:String(i)}}}}));s.ingest(b.sessionId,{events:rows,cursor:'native-opaque',subscription:{}});let page=s.messagesPage();assert.equal(page.messages.length,100);assert.equal(page.messages[0].sequence,152);const before=page.messageHistory.nextBefore!;page=s.messagesPage({before});assert.equal(page.messages[0].sequence,52);page=s.messagesPage({before:page.messageHistory.nextBefore!});assert.equal(page.messages.length,51);assert.equal(page.messageHistory.hasOlder,false);assert.equal(s.cursor(b.sessionId),'native-opaque');assert.throws(()=>s.messagesPage({before:Buffer.from(JSON.stringify([1,'foreign',152,'e151'])).toString('base64url')}),/another Session/);assert.throws(()=>s.messagesPage({limit:101}));s.close();
});
test('all unresolved commands survive snapshot bounds; old exact lookup retains durable observation',t=>{
 const s=new RuntimeStore(file(t)),b=s.ensureBinding('http://127.0.0.1:9911');const old=s.prepare('chat','old-chat-command',{text:'old'});s.record(old.id,'accepted',{event_id:'old-event'});s.ingest(b.sessionId,{events:[{io_version:'1',type:'input.accepted',event_id:'old-event',sequence:1,session_id:b.sessionId}],cursor:'native',subscription:{}});
 for(let i=0;i<140;i++){const c=s.prepare('chat','done-key-'+String(i).padStart(8,'0'),{text:String(i)});s.record(c.id,'accepted');s.prepare('chat','pending-key-'+String(i).padStart(8,'0'),{text:'pending'});}
 assert.equal(s.snapshot().commands.filter(c=>c.status==='pending').length,140);assert.equal(s.snapshot().commands.filter(c=>c.status==='accepted').length,100);assert.equal(s.commandLookup(old.key).command!.observation.acceptedInput!.eventId,'old-event');assert.equal(s.recoverableCommands().length,140);s.close();
});
test('submitting command becomes unknown on restart and retained rejected successor never erases predecessor',t=>{
 const path=file(t);let s=new RuntimeStore(path);const c=s.prepare('objective_control','original-control-key',{objectiveId:'o',action:'pause',expectedRevision:1});s.attempted(c.id);s.close();s=new RuntimeStore(path);assert.equal(s.command(c.id)!.status,'unknown');const n=s.prepare('objective_control','successor-control-key',{objectiveId:'o',action:'resume',expectedRevision:2,reviewedUnknownControlKey:c.key,acknowledgeUncertainOutcome:true});s.record(n.id,'rejected');assert.equal(s.commandLookup(c.key).command!.laterControlReview!.status,'rejected');assert.equal(s.command(c.id)!.status,'unknown');s.close();
});
test('bootstrap authorization denial marks the durable command rejected and explicit replay performs no request',async t=>{
 let reads=0;const s=new RuntimeService({dbPath:file(t),baseUrl:'http://127.0.0.1:9911',autoStart:false,fetch:async()=>{reads++;return Response.json({error:{code:'forbidden'}},{status:403});}});await assert.rejects(s.sendChat('must not send','denied-chat-command'));assert.equal(s.commandLookup('denied-chat-command').command!.status,'rejected');assert.equal(s.commandLookup('denied-chat-command').command!.errorCode,'upstream_authorization_denied');const before=reads;await assert.rejects(s.sendChat('must not send','denied-chat-command'));assert.equal(reads,before);assert.equal(s.store.recoverableCommands().length,0);await s.close();
});
test('two concurrent reviews cannot admit two successor controls for one unknown predecessor',async t=>{
 const b=backend(),s=service(file(t),b);await s.refresh();await s.createObjective('Task','create-task-original');const o=s.store.objectives()[0];b.lose('control');await assert.rejects(s.controlObjective(o.id,'pause',1,'unknown-task-control'));const review={reviewedUnknownControlKey:'unknown-task-control',acknowledgeUncertainOutcome:true};const results=await Promise.allSettled([s.controlObjective(o.id,'resume',2,'review-successor-one',review),s.controlObjective(o.id,'resume',2,'review-successor-two',review)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(s.store.commands().filter(c=>c.payload.reviewedUnknownControlKey==='unknown-task-control').length,1);assert.equal(s.store.commandByKey('unknown-task-control')!.status,'unknown');await s.close();
});
test('typed history catchup budget is explicit and never substitutes receipt or decoded cursors',async t=>{
 const b=backend();let n=0;const fetcher:typeof fetch=async(raw,init)=>new URL(String(raw)).pathname.endsWith('/io/events')?Response.json({events:[],cursor:'opaque-page-'+(++n),subscription:{}}):b.fetcher(raw,init);const s=new RuntimeService({dbPath:file(t),baseUrl:'http://127.0.0.1:9911',fetch:fetcher,autoStart:false});await s.refresh();assert.equal(n,16);assert.deepEqual(s.snapshot().historyProjection,{incomplete:true,pageBudget:16});assert.equal(s.store.cursor(s.store.binding()!.sessionId),'opaque-page-16');await s.close();
});

test('response-lost turn cancellation preserves uncertainty after stale retry and restart',async t=>{
 const path=file(t),b=backend();let revision=1,cancellations=0;
 const fetcher:typeof fetch=async(raw,init={})=>{
  if(new URL(String(raw)).pathname.endsWith('/turns/root-cancel/thread')){
   if(init.method==='POST'){const input=JSON.parse(String(init.body));cancellations++;if(input.expected_revision!==revision)return Response.json({error:{code:'revision_conflict'}},{status:409});revision++;throw new TypeError('response lost after cancellation');}
   return Response.json({status:'cancelled',revision});
  }
  return b.fetcher(raw,init);
 };
 const options={dbPath:path,baseUrl:'http://127.0.0.1:9911',fetch:fetcher,autoStart:false};let s=new RuntimeService(options);await s.refresh();const session=s.store.binding()!.sessionId;
 s.store.ingest(session,{events:[{io_version:'1',type:'input.accepted',event_id:'turn-input',sequence:1,session_id:session,root_turn_id:'root-cancel'}],cursor:'same-cursor',subscription:{}},s.store.cursor(session));
 await assert.rejects(s.cancelTurn('root-cancel',1,'lost-turn-cancel'));assert.equal(s.commandLookup('lost-turn-cancel').command!.status,'unknown');
 await assert.rejects(s.cancelTurn('root-cancel',1,'lost-turn-cancel'));assert.equal(s.commandLookup('lost-turn-cancel').command!.status,'unknown');await s.close();s=new RuntimeService(options);
 await assert.rejects(s.cancelTurn('root-cancel',1,'lost-turn-cancel'));assert.equal(s.commandLookup('lost-turn-cancel').command!.status,'unknown');assert.equal(cancellations,3);await s.close();
});
