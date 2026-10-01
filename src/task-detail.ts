import type {IoEvent, RuntimeObjective, RuntimeApproval} from './morphz-adapter.ts';
import type {ArtifactView} from './artifacts.ts';
import type {UserBinding} from './runtime-store.ts';
import {ConflictError} from './store.ts';

type Row=Record<string,any>;
const record=(v:unknown):Row=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const rows=(v:unknown):Row[]=>Array.isArray(v)?v.map(record):[];
const text=(v:unknown,max=500)=>typeof v==='string'?v.slice(0,max):null;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,512}$/.test(v);
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const route=(event:Row,key:string)=>event.payload?.[key]??record(event.payload?.route)[key];
const terminal=new Set(['completed','cancelled','failed']);
export function taskWait(value:unknown){
 const w=record(value);if(!w.kind)return null;
 const labels:Record<string,string>={tool_task:'等待工具任务',delegation:'等待委派任务',thread_group:'等待协作任务组',timer:'等待指定时刻',permission:'等待操作审批',user_input:'等待用户输入',external_event:'等待外部事件',resource_available:'等待资源可用'};
 if(!Object.hasOwn(labels,w.kind))return {kind:'unknown',label:'等待条件尚未识别'};
 const result:Row={kind:w.kind,label:labels[w.kind]};
 for(const key of ['task_id','delegation_id','group_id','request_id','session_id'])if(id(w[key]))result[key]=w[key];
 if(w.kind==='timer'&&typeof w.deadline==='string'&&Number.isFinite(Date.parse(w.deadline)))result.deadline=w.deadline;
 // Do not project arbitrary event topics, resource names, or unseen questions.
 if(w.kind==='user_input')result.questionText=null;
 return result;
}
export interface TaskDetailInput {
 binding:UserBinding; objective:RuntimeObjective; scheduler:Row; nativeEvents?:Row[];
 ioEvents:IoEvent[]; artifacts:ArtifactView[]; approvals?:RuntimeApproval[];
 previous?:TaskDetail; fresh?:boolean; checkedAt?:number; reasons?:string[];
}
export interface TaskDetail {
 objective:{id:string;prompt:string;status:string;revision:number;generation:number;statusReason:string|null;wait:Row|null;terminal:boolean};
 freshness:{fresh:boolean;checkedAt:number;reason:string|null};
 deliveries:Array<{eventId:string;text:string|null;threadId:string;rootTurnId:string;activationId:string|null;association:string;createdAt:string|null;resources:ArtifactView[]}>;
 threads:Row[]; approvals:Row[]; history:Row[]; unassociatedResources:number;
 bounds:{incomplete:boolean;reasons:string[]}; authoredDocuments?:unknown;
}
/** Pure whitelist projection. Only native supervision or exact Objective-to-Activation
 * evidence associates work. Text, timestamps and latest replies never do. */
export function projectTaskDetail(input:TaskDetailInput):TaskDetail {
 const b=input.binding,o=input.objective;
 if(!b.verified||!b.principalId||!id(o.id)||o.agent_id!==b.agentId||o.context_id!==b.contextId||o.coordinator_session_id!==b.sessionId||o.delivery_session_id!==b.sessionId||(o.initiating_principal_id!=null&&o.initiating_principal_id!==b.principalId)||!positive(o.generation)||!Number.isSafeInteger(o.revision)||o.revision<0)throw new ConflictError('Task detail is outside the verified owner Session');
 if(input.scheduler.context_id!==b.contextId)throw new ConflictError('Task detail scheduler Context changed');
 if(input.previous&&input.previous.objective.id!==o.id)throw new ConflictError('Cached task detail identity changed');
 const reasons=new Set(input.reasons??[]),previous=input.previous;
 for(const [key,value] of Object.entries(record(input.scheduler.detail_bounds)))if(key.startsWith('has_more_')&&value===true)reasons.add(key);
 if(input.ioEvents.length>20000)reasons.add('typed_history_detail_limit');
 const scoped=(r:Row)=>r.agent_id===b.agentId&&r.context_id===b.contextId&&r.session_id===b.sessionId&&(r.initiating_principal_id==null||r.initiating_principal_id===b.principalId);
 const eventScoped=(e:Row)=>route(e,'session_id')===b.sessionId&&(route(e,'context_id')==null||route(e,'context_id')===b.contextId)&&(route(e,'principal_id')==null||route(e,'principal_id')===b.principalId);
 const native=(input.nativeEvents??[]).filter(e=>id(e.id)&&eventScoped(e));
 const sources=rows(input.scheduler.threads).filter(s=>{const t=record(s.thread);return id(t.id)&&id(t.root_turn_id)&&scoped(t);});
 const byThread=new Map(sources.map(s=>[s.thread.id,s]));
 const selected=new Map<string,{snapshot:Row;generation:number;association:string;activationIds:Set<string>|null}>();
 for(const s of sources){const t=s.thread,supervision=record(t.supervision);if(supervision.supervisor_kind==='objective'&&supervision.supervisor_id===o.id&&positive(supervision.generation)&&supervision.generation<=o.generation)selected.set(t.id,{snapshot:s,generation:supervision.generation,association:'objective_supervision',activationIds:null});}
 // An attached child is related only through an already-proven exact parent and
 // its execution generation. Merely sharing root_turn_id is insufficient.
 for(let pass=0;pass<32;pass++){let changed=false;for(const s of sources){const t=s.thread,p=record(t.supervision);if(selected.has(t.id)||p.supervisor_kind!=='thread'||p.lifetime!=='attached'||p.supervisor_id!==p.parent_thread_id)continue;const parent=selected.get(p.parent_thread_id);if(parent&&p.generation===parent.snapshot.thread.generation){selected.set(t.id,{snapshot:s,generation:parent.generation,association:'attached_parent_supervision',activationIds:null});changed=true;}}if(!changed)break;}
 const activations=new Map<string,{snapshot:Row;row:Row}>();
 for(const snapshot of sources)for(const row of rows(snapshot.activations)){const a=record(row.activation);if(id(a.id)&&scoped(a)&&a.root_turn_id===snapshot.thread.root_turn_id)activations.set(a.id,{snapshot,row});}
 const anchors=new Set<string>();
 const objectiveRow=rows(input.scheduler.objectives).find(r=>r.objective?.id===o.id),active=record(objectiveRow?.active_evaluation);
 if(id(active.id)&&scoped(active))anchors.add(active.id);
 for(const e of native){if(route(e,'objective_id')===o.id&&id(route(e,'activation_id'))){const generation=route(e,'objective_generation');if(generation==null||(positive(generation)&&generation<=o.generation))anchors.add(route(e,'activation_id'));}}
 for(const prior of previous?.threads??[])if(prior.association==='objective_evaluation')for(const a of rows(prior.activations))if(id(a.id))anchors.add(a.id);
 for(const activationId of anchors){const found=activations.get(activationId);if(!found)continue;const t=found.snapshot.thread,supervision=record(t.supervision);if(supervision.supervisor_kind==='objective'&&supervision.supervisor_id!==o.id)continue;const existing=selected.get(t.id);if(existing?.activationIds===null)continue;if(existing)existing.activationIds!.add(activationId);else selected.set(t.id,{snapshot:found.snapshot,generation:o.generation,association:'objective_evaluation',activationIds:new Set([activationId])});}
 const pending=new Map((input.approvals??[]).map(a=>[a.id,a])),approvals:Row[]=[],threads:Row[]=[];
 for(const [threadId,evidence] of [...selected].slice(0,100)){
  const s=evidence.snapshot,t=s.thread,projected:Row[]=[];
  for(const row of rows(s.activations).slice(0,200)){
   const a=record(row.activation);if(!scoped(a)||a.root_turn_id!==t.root_turn_id||!id(a.id)||(evidence.activationIds&&!evidence.activationIds.has(a.id)))continue;
   const jobs:Row[]=[];
   for(const entry of rows(row.jobs).slice(0,200)){
    const j=record(entry.job);if(!id(j.id)||!scoped(j)||j.thread_id!==threadId||j.activation_id!==a.id)continue;
    jobs.push({id:j.id,toolName:text(j.tool_name,120),status:text(j.status,80),cancelRequested:j.cancel_requested_at!=null,resultEventId:id(j.result_event_id)?j.result_event_id:null});
    const ap=record(entry.approval),p=pending.get(ap.id)??ap;
    if(id(p.id)&&p.job_id===j.id&&p.status==='pending_human'&&Number.isSafeInteger(p.revision))approvals.push({id:p.id,revision:p.revision,status:p.status,jobId:j.id,threadId,toolName:text(j.tool_name,120)});
   }
   projected.push({id:a.id,generation:a.generation,status:text(a.status,80),jobs});
   if(rows(row.jobs).length>200)reasons.add('jobs_detail_limit');
  }
  if(rows(s.activations).length>200)reasons.add('activations_detail_limit');
  threads.push({id:threadId,rootTurnId:t.root_turn_id,revision:t.revision,generation:t.generation,objectiveGeneration:evidence.generation,association:evidence.association,kind:text(t.kind,80),lifecycle:text(t.lifecycle,80),controlState:text(t.control_state,80),phase:text(s.phase,80),deliveryStatus:text(t.delivery_status,80),activations:projected});
 }
 if(selected.size>100)reasons.add('threads_detail_limit');
 const nativeById=new Map((input.nativeEvents??[]).filter(e=>id(e.id)).map(e=>[e.id,e]));
 const deliveries=new Map((previous?.deliveries??[]).map(d=>[d.eventId,d]));
 for(const event of input.ioEvents.slice(-20000)){
  if(event.type!=='output.committed'||(event.session_id!=null&&event.session_id!==b.sessionId)||(event.principal_id!=null&&event.principal_id!==b.principalId))continue;
  const raw=nativeById.get(event.event_id);if(raw&&!eventScoped(raw))continue;const explicit=raw&&route(raw,'objective_id');if(explicit!=null&&explicit!==o.id)continue;
  if(raw&&route(raw,'principal_id')!=null&&route(raw,'principal_id')!==b.principalId)continue;
  const threadId=event.thread_id??(raw&&route(raw,'thread_id')),root=event.root_turn_id??(raw&&route(raw,'root_turn_id')),activation=event.activation_id??(raw&&route(raw,'activation_id'));
  if(!id(threadId)||!id(root))continue;
  const evidence=selected.get(threadId);if(!evidence||evidence.snapshot.thread.root_turn_id!==root)continue;
  if(raw&&((route(raw,'thread_id')!=null&&route(raw,'thread_id')!==threadId)||(route(raw,'root_turn_id')!=null&&route(raw,'root_turn_id')!==root)))continue;
  if(evidence.activationIds&&(!id(activation)||!evidence.activationIds.has(activation)))continue;
  const content=event.message?.content,value=record(content?.value),body=content?.encoding==='json'?text(value.text,100000):content?.encoding==='utf8'?text(content.text,100000):null;
  const delivery={eventId:event.event_id,text:body,threadId,rootTurnId:root,activationId:id(activation)?activation:null,association:evidence.association,createdAt:text(event.timestamp,100),resources:input.artifacts.filter(a=>a.sourceEventId===event.event_id&&a.origin==='output')};
  const old=deliveries.get(event.event_id);if(old&&JSON.stringify(old)!==JSON.stringify(delivery))throw new ConflictError('Immutable task delivery provenance changed');
  deliveries.set(event.event_id,delivery);
 }
 const history=new Map((previous?.history??[]).map(e=>[e.eventId,e]));
 for(const e of native){if(route(e,'objective_id')!==o.id&&route(e,'requested_objective_id')!==o.id)continue;const topic=text(e.topic,160);if(!topic||!topic.startsWith('objective/'))continue;history.set(e.id,{eventId:e.id,topic,createdAt:text(e.timestamp,100),status:text(e.payload?.status,80)});}
 const regressed=previous&&previous.objective.revision>o.revision;if(regressed)reasons.add('native_revision_regressed');
 const projectedObjective={id:o.id,prompt:o.stated_objective,status:o.status,revision:o.revision,generation:o.generation,statusReason:text(o.status_reason,4000),wait:taskWait(o.wait_condition),terminal:terminal.has(o.status)};
 const allDeliveries=[...deliveries.values()],resourceIds=new Set(allDeliveries.flatMap(d=>d.resources.map(a=>a.id)));
 if(allDeliveries.length>500)reasons.add('deliveries_detail_limit');
 if(history.size>500)reasons.add('history_detail_limit');
 return {objective:regressed?previous!.objective:projectedObjective,freshness:{fresh:input.fresh!==false&&!regressed,checkedAt:input.checkedAt??Date.now(),reason:regressed?'native_revision_regressed':input.fresh===false?'runtime_evidence_unavailable':null},deliveries:allDeliveries.slice(-500),threads,approvals:[...new Map(approvals.map(a=>[a.id,a])).values()],history:[...history.values()].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).slice(-500),unassociatedResources:input.artifacts.filter(a=>a.origin==='output'&&!resourceIds.has(a.id)).length,bounds:{incomplete:reasons.size>0,reasons:[...reasons]}};
}
