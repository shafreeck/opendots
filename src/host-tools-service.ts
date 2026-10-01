import type {DatabaseSync}from'node:sqlite';
import {readHostToolsConfig,type HostToolsConfig}from'./host-tools-config.ts';
import {NativeHostListener,HOST_CONNECTOR_PATH,HOST_CALENDAR_PATH,HOST_DOCUMENT_PATH,type NativeHostRoute}from'./host-tools-listener.ts';
import {NativeHostAuthority}from'./native-host-authority.ts';
import {ConnectorHost}from'./connector-host.ts';
import {GitHubPublicConnector}from'./connector-github-public.ts';
import {AuthoredDocumentHost}from'./authored-document-host.ts';
import {AUTHORED_DOCUMENT_TOOL}from'./authored-documents.ts';
import {CalendarProposalHost}from'./calendar-proposal-host.ts';
import {CALENDAR_TOOL}from'./calendar-proposals.ts';
import {CONNECTOR_TOOL,ConnectorError,checkConnector,connectorJson}from'./connector-types.ts';

interface SavedBinding{userId:string;principalId:string|null;agentId:string;contextId:string;sessionId:string;runtimeOrigin:string;verified:boolean;}
export interface ConfiguredHostToolsOptions{
  configPath:string;config:HostToolsConfig;runtimeOrigin:string;operatorToken?:string;
  store:{db:DatabaseSync;binding():SavedBinding|undefined};runtimeFetch?:typeof fetch;githubFetch?:typeof fetch;
  ownerAuthenticationConfigured?:boolean;
  calendarFactory?:(authority:NativeHostAuthority,authorize:()=>Promise<void>)=>CalendarProposalHost;
  authoredFactory?:(authority:NativeHostAuthority,authorize:()=>Promise<void>)=>AuthoredDocumentHost;
}
/** One explicitly configured private native listener, separately authorized
 * tool identities. V1 GitHub semantics stay unchanged; calendar is proposal-only. */
export class ConfiguredHostTools{
  private options:ConfiguredHostToolsOptions;private authority:NativeHostAuthority;private listener:NativeHostListener;
  private github?:ConnectorHost;private calendar?:CalendarProposalHost;private authored?:AuthoredDocumentHost;private closed=false;private starting?:Promise<void>;private closing?:Promise<void>;
  private lifetime=new AbortController();
  private retryTimer?:NodeJS.Timeout;private retryDelay=250;private nextRetryAt:number|null=null;
  private state:'configured'|'starting'|'ready'|'unavailable'|'closed'='configured';
  private githubRegistration:'unverified'|'advertised'|'missing'='unverified';private calendarRegistration:'unverified'|'advertised'|'missing'='unverified';private authoredRegistration:'unverified'|'advertised'|'missing'='unverified';
  constructor(options:ConfiguredHostToolsOptions){
    this.options={...options};checkConnector(options.config.runtimeOrigin===options.runtimeOrigin,'connector_runtime_origin_mismatch',403);
    const tools=options.config.tools;checkConnector(!tools.authoredDocuments||options.ownerAuthenticationConfigured===true,'authored_owner_authentication_required',400);checkConnector(!tools.calendarProposals||options.ownerAuthenticationConfigured===true,'calendar_owner_authentication_required',400);
    for(const entry of Object.values(tools))checkConnector(!options.operatorToken||entry!.callbackToken!==options.operatorToken,'connector_separate_callback_token_required');
    this.assertPolicy();
    const make=(toolName:typeof CONNECTOR_TOOL|typeof CALENDAR_TOOL|typeof AUTHORED_DOCUMENT_TOOL)=>new NativeHostAuthority({baseUrl:options.runtimeOrigin,binding:options.config.binding,operatorToken:options.operatorToken,fetch:options.runtimeFetch,toolName});
    this.authority=make(tools.githubPublic?CONNECTOR_TOOL:tools.calendarProposals?CALENDAR_TOOL:AUTHORED_DOCUMENT_TOOL);const routes:NativeHostRoute[]=[];
    if(tools.githubPublic){const config=tools.githubPublic;this.github=new ConnectorHost({db:options.store.db,token:config.callbackToken,runtime:this.authority,adapters:[new GitHubPublicConnector({repositories:config.repositories,fetch:options.githubFetch})],authorize:async()=>this.assertPolicy()});routes.push({path:HOST_CONNECTOR_PATH,token:config.callbackToken,handle:(authorization,body,signal)=>this.github!.handle(authorization,body,signal)});}
    if(tools.calendarProposals){checkConnector(typeof options.calendarFactory==='function','calendar_host_factory_required');this.calendar=options.calendarFactory(make(CALENDAR_TOOL),async()=>this.assertPolicy());routes.push({path:HOST_CALENDAR_PATH,token:tools.calendarProposals.callbackToken,handle:(_authorization,body,signal)=>this.calendar!.handle(body,signal)});}
    if(tools.authoredDocuments){checkConnector(typeof options.authoredFactory==='function','authored_host_factory_required');this.authored=options.authoredFactory(make(AUTHORED_DOCUMENT_TOOL),async()=>this.assertPolicy());routes.push({path:HOST_DOCUMENT_PATH,token:tools.authoredDocuments.callbackToken,handle:(_authorization,body,signal)=>this.authored!.handle(body,signal)});}
    this.listener=new NativeHostListener({port:options.config.callbackPort,routes});
  }
  private assertPolicy(){checkConnector(!this.closed,'connector_host_closed',503);const c=this.options.config,current=readHostToolsConfig(this.options.configPath);checkConnector(connectorJson(c)===connectorJson(current),'connector_configuration_changed',403);const saved=this.options.store.binding();checkConnector(saved?.verified===true&&saved.userId===c.ownerId&&saved.runtimeOrigin===c.runtimeOrigin&&saved.principalId===c.binding.principalId&&saved.agentId===c.binding.agentId&&saved.contextId===c.binding.contextId&&saved.sessionId===c.binding.sessionId,'connector_saved_binding_required',403);}
  snapshot(){return{status:this.state,access:'public_data' as const,accountConnected:false as const,probePerformed:false as const,callbackListening:this.listener.snapshot().listening,nativeRegistration:this.githubRegistration,message:this.state==='ready'?'Dedicated native callback ready for allowlisted public reads; no GitHub account connected':this.state==='closed'?'Connector callback stopped':'Connector setup or native identity is not ready; no account connection or public API probe'};}
  calendarSnapshot(){return{enabled:Boolean(this.calendar),status:this.state,callbackListening:this.listener.snapshot().listening,nativeRegistration:this.calendarRegistration,tool:CALENDAR_TOOL,canSchedule:false,requiresOwnerConfirmation:true};}
  authoringSnapshot(){return{enabled:Boolean(this.authored),status:this.state,callbackListening:this.listener.snapshot().listening,nativeRegistration:this.authoredRegistration,tool:AUTHORED_DOCUMENT_TOOL,source:'opendots_authored' as const,formats:['text','markdown','csv'],nextRetryAt:this.nextRetryAt};}
  catalogue(){this.assertPolicy();return{...this.snapshot(),catalogue:this.github?.catalogue()??{source:'opendots_registered_adapters',nativeRegistrationVerified:false,connectors:[]}};}
  async nativeCatalogue(signal?:AbortSignal){this.assertPolicy();const result=await this.authority.catalogue(AbortSignal.any([this.lifetime.signal,...(signal?[signal]:[])]));this.assertPolicy();const capabilities=result.targets.find(t=>t.id==='target-default')?.capabilities??[];this.githubRegistration=capabilities.includes(CONNECTOR_TOOL)?'advertised':'missing';this.calendarRegistration=capabilities.includes(CALENDAR_TOOL)?'advertised':'missing';this.authoredRegistration=capabilities.includes(AUTHORED_DOCUMENT_TOOL)?'advertised':'missing';return result;}
  private schedule(delay:number){
    if(this.closed)return;if(this.retryTimer)clearTimeout(this.retryTimer);
    this.nextRetryAt=this.state==='ready'?null:Date.now()+delay;
    this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;void this.attempt().catch(()=>undefined);},delay);this.retryTimer.unref();
  }
  private attempt():Promise<void>{
    if(this.starting)return this.starting;checkConnector(!this.closed,'connector_host_closed',503);
    if(this.retryTimer){clearTimeout(this.retryTimer);this.retryTimer=undefined;}this.nextRetryAt=null;
    if(this.state!=='ready')this.state='starting';
    const operation=(async()=>{try{
      this.assertPolicy();await this.authority.verifyBinding(this.lifetime.signal);this.assertPolicy();
      await this.listener.start();checkConnector(!this.closed,'connector_host_closed',503);this.state='ready';this.retryDelay=250;
    }catch{if(!this.closed)this.state='unavailable';throw new ConnectorError('connector_startup_unavailable',503);}})();
    this.starting=operation;
    void operation.then(()=>{if(this.starting===operation)this.starting=undefined;this.schedule(5000);},()=>{if(this.starting===operation)this.starting=undefined;const delay=this.retryDelay;this.retryDelay=Math.min(30000,delay*2);this.schedule(delay);});
    return operation;
  }
  start():Promise<void>{if(this.closed)return Promise.reject(new ConnectorError('connector_host_closed',503));if(this.state==='ready'&&this.listener.snapshot().listening)return Promise.resolve();return this.attempt();}
  close():Promise<void>{if(this.closing)return this.closing;this.closed=true;this.state='closed';if(this.retryTimer)clearTimeout(this.retryTimer);this.retryTimer=undefined;this.nextRetryAt=null;this.lifetime.abort();const listener=this.listener.close(),github=this.github?.close(),calendar=this.calendar?.close(),authored=this.authored?.close();this.closing=(async()=>{await this.starting?.catch(()=>undefined);await Promise.all([listener,github,calendar,authored]);})();return this.closing;}
}
