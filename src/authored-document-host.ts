import { AuthoredDocuments, AuthoredDocumentError, AUTHORED_DOCUMENT_TOOL, validateAuthoredDocumentRequest } from './authored-documents.ts';
import { ConnectorError, checkConnector, connectorId, connectorJson, connectorKeys, connectorRecord, type Json } from './connector-types.ts';
import type { NativeHostAuthority, NativeHostEnvelope } from './native-host-authority.ts';

export function parseAuthoredDocumentEnvelope(value:unknown):NativeHostEnvelope {
  connectorJson(value);const e=connectorRecord(value);connectorKeys(e,['protocol','tool','invocation','arguments']);
  checkConnector(e.protocol===1&&e.tool===AUTHORED_DOCUMENT_TOOL);
  const i=connectorRecord(e.invocation);connectorKeys(i,['job_id','tool_call_id','session_id','context_id','principal_id','agent_id','thread_id','target_id']);checkConnector(Object.values(i).every(connectorId));
  validateAuthoredDocumentRequest(e.arguments);return JSON.parse(connectorJson(e)) as NativeHostEnvelope;
}
export interface AuthoredDocumentHostOptions {
  documents:Pick<AuthoredDocuments,'receipt'|'execute'>;
  authority:Pick<NativeHostAuthority,'verifyDocumentInvocation'>;
  authorize:()=>Promise<void>;
}
/** Private native capability; no browser mutations, path imports, external upload,
 * credential setup or Runtime mutation is present in this host. */
export class AuthoredDocumentHost {
  private readonly options:AuthoredDocumentHostOptions;private readonly lifetime=new AbortController();private readonly calls=new Set<Promise<Json>>();private closing?:Promise<void>;
  constructor(options:AuthoredDocumentHostOptions){checkConnector(typeof options.authorize==='function'&&typeof options.authority?.verifyDocumentInvocation==='function','connector_authorizer_required');this.options={...options};}
  private check(signal:AbortSignal){checkConnector(!signal.aborted,'connector_host_closed',503);}
  private async bounded<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{let abort!:()=>void;try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{abort=()=>reject(new ConnectorError('connector_host_closed',503));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}}
  private async authorize(signal:AbortSignal){this.check(signal);try{await this.bounded(this.options.authorize(),signal);}catch(error){if(signal.aborted)throw new ConnectorError('connector_host_closed',503);throw new ConnectorError('connector_permission_denied',403);}this.check(signal);}
  handle(raw:unknown,signal:AbortSignal):Promise<Json>{
    if(this.lifetime.signal.aborted)return Promise.reject(new ConnectorError('connector_host_closed',503));
    const combined=AbortSignal.any([signal,this.lifetime.signal]);const call=Promise.resolve().then(()=>this.execute(raw,combined));this.calls.add(call);void call.then(()=>this.calls.delete(call),()=>this.calls.delete(call));return call;
  }
  private async execute(raw:unknown,signal:AbortSignal):Promise<Json>{try{
    const e=parseAuthoredDocumentEnvelope(raw);await this.authorize(signal);const old=this.options.documents.receipt(e);
    const proof=await this.bounded(this.options.authority.verifyDocumentInvocation(e,old!==null,signal),signal);
    await this.authorize(signal);this.check(signal);
    if(old!==null)return this.options.documents.receipt(e,proof)!;
    return this.options.documents.execute(e,proof);
  }catch(error){if(error instanceof AuthoredDocumentError)throw new ConnectorError(error.code,error.status);if(error instanceof ConnectorError)throw error;throw new ConnectorError('connector_callback_unavailable',503);}}
  close(){if(this.closing)return this.closing;this.lifetime.abort();return this.closing=Promise.allSettled([...this.calls]).then(()=>undefined);}
}
/** Inert data builder only. Operator provisions tokens/manifest separately. */
export function authoredDocumentRegistration(input:{contextId:string;endpoint:string;token:string}){
  checkConnector(connectorId(input.contextId)&&/^[\x21-\x7e]{32,1024}$/.test(input.token),'connector_manifest_invalid');let url:URL;try{url=new URL(input.endpoint);}catch{throw new ConnectorError('connector_manifest_invalid');}
  checkConnector(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/api/host-tools/documents/call','connector_manifest_invalid');
  return{endpoint:url.href,token:input.token,context_ids:[input.contextId],idempotent_requests:[],definition:{name:AUTHORED_DOCUMENT_TOOL,description:'Save real generated UTF-8 text, Markdown or CSV into private opendots product documents. Actions: create(name,format=text|markdown|csv,content), append(documentId,expectedRevision,parentVersionId,content), list(afterId?,limit<=20), get(documentId), status(documentId), history(documentId,afterId?,limit<=20). Content maximum 49152 UTF-8 bytes and full encoded request maximum 65536 bytes. New versions are immutable; append requires the exact displayed revision and parent. Results include SHA256, immutable downloadPath and server-verified native provenance. This is private product storage, not a Runtime artifact or an external upload. No binary files, URLs, paths, imports, arbitrary identities, approval or request keys. Do not claim content saved without successful receipt. Same Call retries return the original result; use a new Call to observe current status.',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{enum:['create','append','list','get','status','history']},name:{type:'string',maxLength:160},format:{enum:['text','markdown','csv']},content:{type:'string'},documentId:{type:'string'},expectedRevision:{type:'integer',minimum:1},parentVersionId:{type:'string'},afterId:{type:'string'},limit:{type:'integer',minimum:1,maximum:20}}}}};
}
