import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { connectorId, connectorJson, connectorKeys, connectorRecord, type Json } from './connector-types.ts';
import type { NativeDocumentProvenance, NativeHostEnvelope } from './native-host-authority.ts';

export const AUTHORED_DOCUMENT_TOOL = 'host_opendots_documents';
export const authoredDocumentLimits = { contentBytes: 49_152, requestBytes: 65_536, receiptBytes: 262_144, receipts: 2000, receiptTotalBytes: 16_777_216, totalBytes: 8_388_608, documents: 200, versions: 1000, page: 20, name: 160 } as const;
export class AuthoredDocumentError extends Error {
  readonly code:string; readonly status:number;
  constructor(code:string,status=409){super(code);this.name='AuthoredDocumentError';this.code=code;this.status=status;}
}
function check(value:unknown,code='authored_document_invalid_request',status=400):asserts value {if(!value)throw new AuthoredDocumentError(code,status);}
const hash=(value:unknown)=>createHash('sha256').update(connectorJson(value,authoredDocumentLimits.requestBytes)).digest('hex');
const wellFormed=(value:string)=>!/[\uD800-\uDFFF]/u.test(value);
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const authoredDocumentId=(value:unknown):value is string=>typeof value==='string'&&new RegExp(`^pdoc-${uuid}$`).test(value);
export const authoredVersionId=(value:unknown):value is string=>typeof value==='string'&&new RegExp(`^pver-${uuid}$`).test(value);
export type AuthoredDocumentFormat='text'|'markdown'|'csv';
const formats={text:{mediaType:'text/plain',extension:'txt'},markdown:{mediaType:'text/markdown',extension:'md'},csv:{mediaType:'text/csv',extension:'csv'}} as const;
export type AuthoredDocumentRequest=
  |{action:'create';name:string;format:AuthoredDocumentFormat;content:string}
  |{action:'append';documentId:string;expectedRevision:number;parentVersionId:string;content:string}
  |{action:'list';afterId?:string;limit?:number}
  |{action:'get'|'status';documentId:string}
  |{action:'history';documentId:string;afterId?:string;limit?:number};
export function validateAuthoredDocumentRequest(value:unknown):AuthoredDocumentRequest {
  connectorJson(value,authoredDocumentLimits.requestBytes);const v=connectorRecord(value);
  if(v.action==='create'){
    connectorKeys(v,['action','name','format','content']);
    check(typeof v.name==='string'&&v.name===v.name.trim()&&v.name.length>=1&&v.name.length<=authoredDocumentLimits.name&&wellFormed(v.name)&&!/[\\/\x00-\x1f\x7f-\x9f]/.test(v.name)&&!['.','..'].includes(v.name));
    check(typeof v.format==='string'&&Object.hasOwn(formats,v.format));
  }else if(v.action==='append'){
    connectorKeys(v,['action','documentId','expectedRevision','parentVersionId','content']);
    check(authoredDocumentId(v.documentId)&&authoredVersionId(v.parentVersionId)&&Number.isSafeInteger(v.expectedRevision)&&Number(v.expectedRevision)>=1);
  }else if(v.action==='get'||v.action==='status') {connectorKeys(v,['action','documentId']);check(authoredDocumentId(v.documentId));}
  else if(v.action==='list'||v.action==='history'){
    connectorKeys(v,v.action==='list'?['action']:['action','documentId'],['afterId','limit']);
    check(v.action==='list'||authoredDocumentId(v.documentId));
    check(v.afterId===undefined||(v.action==='list'?authoredDocumentId(v.afterId):authoredVersionId(v.afterId)));
    check(v.limit===undefined||(Number.isSafeInteger(v.limit)&&Number(v.limit)>=1&&Number(v.limit)<=authoredDocumentLimits.page));
  }else throw new AuthoredDocumentError('authored_document_invalid_request',400);
  if(v.action==='create'||v.action==='append')check(typeof v.content==='string'&&wellFormed(v.content)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(v.content)&&Buffer.byteLength(v.content,'utf8')<=authoredDocumentLimits.contentBytes);
  return JSON.parse(connectorJson(v)) as AuthoredDocumentRequest;
}
export interface AuthoredDocumentView {id:string;name:string;format:AuthoredDocumentFormat;source:'opendots_authored';revision:number;currentVersionId:string;createdAt:number;updatedAt:number;}
export interface AuthoredDocumentVersion {id:string;documentId:string;revision:number;parentVersionId:string|null;source:'opendots_authored';sha256:string;sizeBytes:number;mediaType:string;name:string;provenance:NativeDocumentProvenance;createdAt:number;downloadPath:string;}
export interface AuthoredDocumentsOptions {
  db:DatabaseSync;
  binding:{ownerId:string;sessionId:string;principalId:string;agentId:string;contextId:string;verified:true};
  /** Local owner admission only. Must be synchronous, including inside COMMIT. */
  assertAuthorized:()=>void;
  now?:()=>number;
}
interface DocumentRow {id:string;owner_id:string;session_id:string;name:string;format:AuthoredDocumentFormat;revision:number;current_version_id:string;created_at:number;updated_at:number;}
interface VersionRow {id:string;document_id:string;revision:number;parent_version_id:string|null;sha256:string;size_bytes:number;provenance_json:string;created_at:number;}
/** Product-owned UTF-8 bytes and append-only versions. Native Runtime remains
 * execution authority; no Runtime resource/event row is synthesized or written. */
export class AuthoredDocuments {
  private readonly options:AuthoredDocumentsOptions;private readonly db:DatabaseSync;private closed=false;
  constructor(options:AuthoredDocumentsOptions){
    check(options.binding?.verified===true&&['ownerId','sessionId','principalId','agentId','contextId'].every(k=>connectorId(options.binding[k as keyof typeof options.binding])),'authored_document_binding_required',403);
    check(typeof options.assertAuthorized==='function','authored_document_authority_required',500);
    this.options={...options,binding:{...options.binding}};this.db=options.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS authored_documents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,name TEXT NOT NULL,format TEXT NOT NULL,revision INTEGER NOT NULL,current_version_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS authored_document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_version_id TEXT,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,provenance_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(document_id,revision));
      CREATE TABLE IF NOT EXISTS authored_document_content(version_id TEXT PRIMARY KEY,bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS authored_document_receipts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,envelope_hash TEXT NOT NULL,provenance_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  private guard(){check(!this.closed,'authored_document_closed',503);const result:unknown=this.options.assertAuthorized();if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==='function')void Promise.resolve(result).catch(()=>undefined);throw new AuthoredDocumentError('authored_document_guard_must_be_synchronous',500);}}
  private transaction<T>(op:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=op();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private row(id:string):DocumentRow {check(authoredDocumentId(id),'authored_document_not_found',404);const b=this.options.binding,row=this.db.prepare('SELECT * FROM authored_documents WHERE id=? AND owner_id=? AND session_id=?').get(id,b.ownerId,b.sessionId) as unknown as DocumentRow|undefined;check(row,'authored_document_not_found',404);return row;}
  private document(r:DocumentRow):AuthoredDocumentView{return{id:r.id,name:r.name,format:r.format,source:'opendots_authored',revision:r.revision,currentVersionId:r.current_version_id,createdAt:r.created_at,updatedAt:r.updated_at};}
  private versionRow(id:string,versionId:string):VersionRow {this.row(id);check(authoredVersionId(versionId),'authored_document_not_found',404);const r=this.db.prepare('SELECT * FROM authored_document_versions WHERE document_id=? AND id=?').get(id,versionId) as unknown as VersionRow|undefined;check(r,'authored_document_not_found',404);return r;}
  private version(r:VersionRow,d:DocumentRow):AuthoredDocumentVersion {const format=formats[d.format];return{id:r.id,documentId:r.document_id,revision:r.revision,parentVersionId:r.parent_version_id,source:'opendots_authored',sha256:r.sha256,sizeBytes:r.size_bytes,mediaType:format.mediaType,name:d.name.toLowerCase().endsWith(`.${format.extension}`)?d.name:`${d.name}.${format.extension}`,provenance:JSON.parse(r.provenance_json),createdAt:r.created_at,downloadPath:`/api/authored-documents/${d.id}/versions/${r.id}/content`};}
  private page(input:{afterId?:string;limit?:number}){const v=connectorRecord(input);connectorKeys(v,[],['afterId','limit']);const limit=input.limit??authoredDocumentLimits.page;check(Number.isSafeInteger(limit)&&limit>=1&&limit<=authoredDocumentLimits.page);return limit;}
  list(input:{afterId?:string;limit?:number}={}) {this.guard();const limit=this.page(input);if(input.afterId!==undefined)this.row(input.afterId);const b=this.options.binding,rows=this.db.prepare('SELECT * FROM authored_documents WHERE owner_id=? AND session_id=? AND id>? ORDER BY id LIMIT ?').all(b.ownerId,b.sessionId,input.afterId??'',limit+1) as unknown as DocumentRow[];return{documents:rows.slice(0,limit).map(r=>this.document(r)),nextCursor:rows.length>limit?rows[limit-1]!.id:null};}
  get(id:string){this.guard();const d=this.row(id);return{document:this.document(d),version:this.version(this.versionRow(id,d.current_version_id),d)};}
  history(id:string,input:{afterId?:string;limit?:number}={}){this.guard();const d=this.row(id),limit=this.page(input),after=input.afterId===undefined?0:this.versionRow(id,input.afterId).revision;const rows=this.db.prepare('SELECT * FROM authored_document_versions WHERE document_id=? AND revision>? ORDER BY revision LIMIT ?').all(id,after,limit+1) as unknown as VersionRow[];return{document:this.document(d),versions:rows.slice(0,limit).map(r=>this.version(r,d)),nextCursor:rows.length>limit?rows[limit-1]!.id:null};}
  private callId(e:NativeHostEnvelope){const i=e.invocation,b=this.options.binding;check(e.protocol===1&&e.tool===AUTHORED_DOCUMENT_TOOL&&i.session_id===b.sessionId&&i.context_id===b.contextId&&i.agent_id===b.agentId&&i.principal_id===b.principalId&&i.target_id==='target-default','authored_document_scope_denied',403);check(Object.values(i).every(connectorId));return 'pdoccall-'+hash([b.ownerId,b.sessionId,e.tool,i.job_id,i.tool_call_id]);}
  /** Does not grant admission: callers must verify native authority even on replay. */
  receipt(e:NativeHostEnvelope,proof?:NativeDocumentProvenance):Json|null {this.guard();const id=this.callId(e),b=this.options.binding,r=this.db.prepare('SELECT envelope_hash,provenance_hash,result_json FROM authored_document_receipts WHERE id=? AND owner_id=? AND session_id=?').get(id,b.ownerId,b.sessionId) as {envelope_hash:string;provenance_hash:string;result_json:string}|undefined;if(!r)return null;check(r.envelope_hash===hash(e),'authored_document_call_conflict',409);if(proof)check(r.provenance_hash===hash(proof),'authored_document_provenance_changed',409);return JSON.parse(r.result_json) as Json;}
  private provenance(e:NativeHostEnvelope,p:NativeDocumentProvenance){const i=e.invocation;check(p&&p.sessionId===i.session_id&&p.principalId===i.principal_id&&p.agentId===i.agent_id&&p.contextId===i.context_id&&p.jobId===i.job_id&&p.callId===i.tool_call_id&&p.threadId===i.thread_id&&connectorId(p.activationId)&&connectorId(p.rootTurnId)&&Number.isSafeInteger(p.threadGeneration)&&p.threadGeneration>=1&&((p.objectiveId===null&&p.objectiveGeneration===null)||(connectorId(p.objectiveId)&&Number.isSafeInteger(p.objectiveGeneration)&&Number(p.objectiveGeneration)>=1)),'authored_document_provenance_invalid',403);return JSON.parse(connectorJson(p)) as NativeDocumentProvenance;}
  /** Only the native host calls this after proving the complete callback. Content,
   * head and receipt commit in one SQLite transaction; retries return old result. */
  execute(e:NativeHostEnvelope,proof:NativeDocumentProvenance):Json {
    const input=validateAuthoredDocumentRequest(e.arguments),provenance=this.provenance(e,proof);this.guard();this.callId(e);
    return this.transaction(()=>{
      this.guard();const old=this.receipt(e,provenance);if(old!==null)return old;
      let result:unknown;
      if(input.action==='create'||input.action==='append'){
        const b=this.options.binding,now=this.options.now?.()??Date.now();let row:DocumentRow,parent:string|null=null;
        if(input.action==='create'){
          const n=Number((this.db.prepare('SELECT count(*) AS n FROM authored_documents WHERE owner_id=? AND session_id=?').get(b.ownerId,b.sessionId) as {n:number}).n);check(n<authoredDocumentLimits.documents,'authored_document_limit',409);
          row={id:'pdoc-'+randomUUID(),owner_id:b.ownerId,session_id:b.sessionId,name:input.name,format:input.format,revision:1,current_version_id:'pver-'+randomUUID(),created_at:now,updated_at:now};
        }else{
          const prior=this.row(input.documentId);check(prior.revision===input.expectedRevision&&prior.current_version_id===input.parentVersionId,'authored_document_head_conflict',409);check(prior.revision<authoredDocumentLimits.versions,'authored_document_limit',409);parent=prior.current_version_id;row={...prior,revision:prior.revision+1,current_version_id:'pver-'+randomUUID(),updated_at:now};
        }
        const bytes=Buffer.from(input.content,'utf8'),sha256=createHash('sha256').update(bytes).digest('hex');
        const totals=this.db.prepare('SELECT count(*) AS count,coalesce(sum(v.size_bytes),0) AS n FROM authored_document_versions v JOIN authored_documents d ON d.id=v.document_id WHERE d.owner_id=? AND d.session_id=?').get(b.ownerId,b.sessionId) as {n:number;count:number};check(Number(totals.count)<authoredDocumentLimits.versions,'authored_document_limit',409);check(Number(totals.n)+bytes.length<=authoredDocumentLimits.totalBytes,'authored_document_storage_limit',409);
        if(input.action==='create')this.db.prepare('INSERT INTO authored_documents VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.owner_id,row.session_id,row.name,row.format,row.revision,row.current_version_id,row.created_at,row.updated_at);
        else {const changed=this.db.prepare('UPDATE authored_documents SET revision=?,current_version_id=?,updated_at=? WHERE id=? AND owner_id=? AND session_id=? AND revision=? AND current_version_id=?').run(row.revision,row.current_version_id,row.updated_at,row.id,b.ownerId,b.sessionId,input.expectedRevision,input.parentVersionId);check(Number(changed.changes)===1,'authored_document_head_conflict',409);}
        const v:VersionRow={id:row.current_version_id,document_id:row.id,revision:row.revision,parent_version_id:parent,sha256,size_bytes:bytes.length,provenance_json:connectorJson(provenance),created_at:now};
        this.db.prepare('INSERT INTO authored_document_versions VALUES(?,?,?,?,?,?,?,?)').run(v.id,v.document_id,v.revision,v.parent_version_id,v.sha256,v.size_bytes,v.provenance_json,v.created_at);
        this.db.prepare('INSERT INTO authored_document_content VALUES(?,?)').run(v.id,bytes);
        result={document:this.document(row),version:this.version(v,row)};
      }else if(input.action==='list')result=this.list({...input.afterId!==undefined?{afterId:input.afterId}:{},...input.limit!==undefined?{limit:input.limit}:{}});
      else if(input.action==='history')result=this.history(input.documentId,{...input.afterId!==undefined?{afterId:input.afterId}:{},...input.limit!==undefined?{limit:input.limit}:{}});
      else result=this.get(input.documentId);
      const encoded=connectorJson(result,authoredDocumentLimits.receiptBytes),b=this.options.binding;
      this.guard();
      const receiptUsage=this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(result_json AS BLOB))),0) AS bytes FROM authored_document_receipts WHERE owner_id=? AND session_id=?').get(b.ownerId,b.sessionId) as {count:number;bytes:number};
      check(Number(receiptUsage.count)<authoredDocumentLimits.receipts&&Number(receiptUsage.bytes)+Buffer.byteLength(encoded)<=authoredDocumentLimits.receiptTotalBytes,'authored_document_receipt_limit',409);
      this.db.prepare('INSERT INTO authored_document_receipts VALUES(?,?,?,?,?,?,?)').run(this.callId(e),b.ownerId,b.sessionId,hash(e),hash(provenance),encoded,this.options.now?.()??Date.now());return JSON.parse(encoded) as Json;
    });
  }
  downloadVersion(id:string,versionId:string){this.guard();const d=this.row(id),version=this.version(this.versionRow(id,versionId),d),r=this.db.prepare('SELECT bytes FROM authored_document_content WHERE version_id=?').get(versionId) as {bytes:Uint8Array}|undefined;check(r?.bytes instanceof Uint8Array&&r.bytes.byteLength===version.sizeBytes&&createHash('sha256').update(r.bytes).digest('hex')===version.sha256,'authored_document_integrity_failed',502);this.guard();return{document:this.document(d),version,bytes:Buffer.from(r.bytes)};}
  /** Exact immutable creator Job AND Thread evidence, never the current head. */
  forTask(input:{objectiveId:string;jobIds:string[];threadIds:string[]}){
    this.guard();check(connectorId(input.objectiveId)&&Array.isArray(input.jobIds)&&Array.isArray(input.threadIds)&&input.jobIds.length<=2000&&input.threadIds.length<=2000&&[...input.jobIds,...input.threadIds].every(connectorId));
    const b=this.options.binding;const rows=this.db.prepare(`SELECT v.* FROM authored_document_versions v JOIN authored_documents d ON d.id=v.document_id WHERE d.owner_id=? AND d.session_id=?
      AND json_extract(v.provenance_json,'$.jobId') IN (SELECT value FROM json_each(?))
      AND json_extract(v.provenance_json,'$.threadId') IN (SELECT value FROM json_each(?))
      AND (json_extract(v.provenance_json,'$.objectiveId') IS NULL OR json_extract(v.provenance_json,'$.objectiveId')=?)
      ORDER BY v.created_at,v.id LIMIT 101`).all(b.ownerId,b.sessionId,JSON.stringify(input.jobIds),JSON.stringify(input.threadIds),input.objectiveId) as unknown as VersionRow[];
    return{items:rows.slice(0,100).map(r=>{const d=this.row(r.document_id);return{document:this.document(d),version:this.version(r,d)};}),truncated:rows.length>100};
  }
  close(){this.closed=true;}
}
