import { previewCalendar, validateCalendarRule, CalendarReminderError } from './calendar-reminders.ts';
import { CALENDAR_TOOL, CalendarProposals, CalendarProposalError } from './calendar-proposals.ts';
import { ConnectorError, checkConnector, connectorJson, connectorKeys, connectorRecord, connectorId, type ConnectorInvocation, type Json } from './connector-types.ts';
import type { NativeHostAuthority, NativeHostEnvelope } from './native-host-authority.ts';

export type CalendarHostRequest = {action:'list';kind:'series'|'proposals';afterId?:string;limit?:number}|{action:'preview';rule:unknown}|{action:'propose';rule:unknown}|{action:'status';proposalId:string};
export function parseCalendarHostEnvelope(value:unknown):NativeHostEnvelope&{arguments:CalendarHostRequest}{
  connectorJson(value);const e=connectorRecord(value);connectorKeys(e,['protocol','tool','invocation','arguments']);checkConnector(e.protocol===1&&e.tool===CALENDAR_TOOL);
  const i=connectorRecord(e.invocation);connectorKeys(i,['job_id','tool_call_id','session_id','context_id','principal_id','agent_id','thread_id','target_id']);checkConnector(Object.values(i).every(connectorId));
  const a=connectorRecord(e.arguments);
  if(a.action==='list'){connectorKeys(a,['action','kind'],['afterId','limit']);checkConnector(a.kind==='series'||a.kind==='proposals');checkConnector(a.afterId===undefined||connectorId(a.afterId));checkConnector(a.limit===undefined||(Number.isInteger(a.limit)&&Number(a.limit)>=1&&Number(a.limit)<=20));}
  else if(a.action==='preview'||a.action==='propose'){connectorKeys(a,['action','rule']);try{validateCalendarRule(a.rule);}catch{throw new ConnectorError('connector_invalid_request',400);}}
  else{connectorKeys(a,['action','proposalId']);checkConnector(a.action==='status'&&typeof a.proposalId==='string'&&/^calprop-[a-f0-9]{64}$/.test(a.proposalId));}
  return JSON.parse(connectorJson(e))as NativeHostEnvelope&{arguments:CalendarHostRequest};
}
export interface CalendarProposalHostOptions{
  authority:Pick<NativeHostAuthority,'verifyInvocation'>;
  proposals:Pick<CalendarProposals,'receipt'|'propose'|'recordReceipt'|'read'|'list'>;
  authorize:()=>Promise<void>;
  listSeries:(input:{afterId?:string;limit?:number})=>Promise<unknown>;
  seriesForProposal:(proposalId:string)=>Promise<unknown>;
  now?:()=>number;
}
/** Native capability ends at an owner-visible candidate. No schedule adapter,
 * Calendar.create, confirmation guard, or browser approval authority is injected. */
export class CalendarProposalHost{
  private options:CalendarProposalHostOptions;private closed=false;private calls=new Set<Promise<Json>>();private closing?:Promise<void>;
  constructor(options:CalendarProposalHostOptions){checkConnector(typeof options.authorize==='function','connector_authorizer_required');this.options={...options};}
  handle(raw:unknown,signal:AbortSignal):Promise<Json>{if(this.closed)return Promise.reject(new ConnectorError('connector_host_closed',503));const call=Promise.resolve().then(()=>this.execute(raw,signal));this.calls.add(call);void call.then(()=>this.calls.delete(call),()=>this.calls.delete(call));return call;}
  private async authorize(signal:AbortSignal){checkConnector(!this.closed&&!signal.aborted,'connector_host_closed',503);try{await this.options.authorize();}catch{throw new ConnectorError('connector_permission_denied',403);}checkConnector(!this.closed&&!signal.aborted,'connector_host_closed',503);}
  private async execute(raw:unknown,signal:AbortSignal):Promise<Json>{
    try{
      const e=parseCalendarHostEnvelope(raw),request=e.arguments;
      await this.authorize(signal);const old=this.options.proposals.receipt(e);
      await this.options.authority.verifyInvocation(e,old!==null,signal);await this.authorize(signal);
      if(old!==null)return old;
      if(request.action==='propose'){const rule=validateCalendarRule(request.rule);return this.options.proposals.propose(e,rule,previewCalendar(rule,this.options.now?.()??Date.now(),3));}
      let result:unknown;
      if(request.action==='preview')result={preview:previewCalendar(request.rule,this.options.now?.()??Date.now(),3),scheduling:'not_admitted',requiresOwnerConfirmation:true};
      else if(request.action==='list')result=request.kind==='proposals'?this.options.proposals.list({afterId:request.afterId,limit:request.limit}):await this.options.listSeries({afterId:request.afterId,limit:request.limit??20});
      else{const proposal=this.options.proposals.read(request.proposalId);result={proposal,series:proposal.state==='admitted'?await this.options.seriesForProposal(request.proposalId):null};}
      await this.authorize(signal);
      return this.options.proposals.recordReceipt(e,JSON.parse(connectorJson(result,262_144))as Json);
    }catch(error){if(error instanceof CalendarProposalError)throw new ConnectorError(error.code,error.status);if(error instanceof ConnectorError)throw error;if(error instanceof CalendarReminderError)throw new ConnectorError('connector_invalid_request',400);throw new ConnectorError('connector_callback_unavailable',503);}
  }
  close(){if(this.closing)return this.closing;this.closed=true;this.closing=Promise.allSettled([...this.calls]).then(()=>undefined);return this.closing;}
}
/** Pure manifest entry builder. Operator must provision the token/manifest and
 * restart Runtime separately; this never creates persistent access itself. */
export function calendarProposalRegistration(input:{contextId:string;endpoint:string;token:string}){
  checkConnector(connectorId(input.contextId)&&/^[\x21-\x7e]{32,1024}$/.test(input.token),'connector_manifest_invalid');let url:URL;try{url=new URL(input.endpoint);}catch{throw new ConnectorError('connector_manifest_invalid');}
  checkConnector(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/api/host-tools/calendar/call','connector_manifest_invalid');
  return{endpoint:url.href,token:input.token,context_ids:[input.contextId],idempotent_requests:[],definition:{name:CALENDAR_TOOL,description:'Read daily/weekly product calendar series, preview a complete rule, or propose a calendar reminder for the owner to review. This tool CANNOT create a recurrence, approve, confirm, pause/resume/cancel a series, or send notifications. A successful proposal is pending_owner_confirmation and not scheduled. Tell the user to review it in the calendar proposals UI; never claim it is scheduled until status reports actual series/native state. Actions: list(kind=series|proposals,afterId?,limit<=20), preview(rule), propose(rule), status(proposalId). Rule fields: intent,timeZone(IANA),frequency(daily|weekly),localTime(HH:mm),startDate,untilDate?,weekdays(sorted ISO1..7 for weekly only),dst:{gap:skip,overlap:earlier|later},missed:skip_unsubmitted,resume:skip_overdue_paused. Existing target-default only; no identity, credential, approval or idempotency-key arguments. Read status with a new tool Call to observe a later owner decision; replaying an old Call returns its original result.',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{enum:['list','preview','propose','status']},kind:{enum:['series','proposals']},afterId:{type:'string'},limit:{type:'integer',minimum:1,maximum:20},rule:{type:'object'},proposalId:{type:'string'}}}}};
}
