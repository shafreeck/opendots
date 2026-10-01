import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MAXIMUM_RESOURCE_BYTES, type ArtifactView } from './artifacts.ts';

export const artifactVersionLimits = { title:160, note:2000, documents:200, versions:1000, page:50, defaultPage:20 } as const;
export class ArtifactVersionError extends Error {
  readonly code:string;readonly status:number;
  constructor(code:string,status=409){super(code);this.name='ArtifactVersionError';this.code=code;this.status=status;}
}
function check(value:unknown,code='artifact_version_invalid_request',status=400):asserts value{if(!value)throw new ArtifactVersionError(code,status);}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const documentId=new RegExp(`^doc-${uuid}$`),versionId=new RegExp(`^ver-${uuid}$`);
function key(value:unknown):asserts value is string{check(typeof value==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(value));}
function record(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{check(value&&typeof value==='object'&&!Array.isArray(value));const object=value as Record<string,unknown>;check(required.every(k=>Object.hasOwn(object,k))&&Object.keys(object).every(k=>required.includes(k)||optional.includes(k)));return object;}
function title(value:unknown){check(typeof value==='string'&&value.trim().length>=1&&value.trim().length<=artifactVersionLimits.title&&!/[\x00-\x1f\x7f]/.test(value));return value.trim();}
function note(value:unknown){if(value===undefined)return '';check(typeof value==='string'&&value.length<=artifactVersionLimits.note&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));return value.trim();}
function artifactId(value:unknown):asserts value is string{check(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));}
export interface CreateArtifactDocumentInput {title:string;artifactId:string;note?:string;idempotencyKey:string;}
export interface AppendArtifactVersionInput {artifactId:string;note?:string;expectedRevision:number;parentVersionId:string;idempotencyKey:string;}
export interface ArtifactDocumentView {id:string;title:string;revision:number;currentVersionId:string;createdAt:number;updatedAt:number;}
export interface VersionArtifact {id:string;sessionId:string;sourceEventId:string;sha256:string;mediaType:string;sizeBytes:number;name:string;origin:'input'|'output';createdAt:string|null;}
export interface ArtifactVersionView {id:string;documentId:string;revision:number;parentVersionId:string|null;note:string;artifact:VersionArtifact;createdAt:number;downloadPath:string;}
type NormalCreate=Required<CreateArtifactDocumentInput>;
type NormalAppend=Required<AppendArtifactVersionInput>&{documentId:string};
export interface ArtifactVersionReceipt {command:{id:string;key:string;kind:'create'|'append';payloadFingerprint:string;input:NormalCreate|NormalAppend};documentAtAdmission:ArtifactDocumentView;version:ArtifactVersionView;}
export interface ResolvedVersionArtifact {sessionId:string;artifact:ArtifactView;}
export interface ArtifactVersionsOptions {
  db:DatabaseSync;
  /** Only a saved, already verified RuntimeStore owner/session may be supplied. */
  binding:{ownerId:string;sessionId:string;verified:true};
  /** Local owner request authority. Must be synchronous; never a native probe. */
  assertAuthorized:()=>void;
  /** NEW admission only: refresh catalogue, verify native principal, use existing
   * Artifacts.download to check actual bytes/size/hash, discard bytes, return DTO. */
  resolveArtifact:(id:string)=>Promise<ResolvedVersionArtifact>;
  /** Existing Artifacts download path; no filesystem or model-generated paths. */
  downloadArtifact:(id:string)=>Promise<ResolvedVersionArtifact&{bytes:Uint8Array}>;
  now?:()=>number;
}
interface DocumentRow{id:string;owner_id:string;session_id:string;title:string;revision:number;current_version_id:string;created_at:number;updated_at:number;}
interface VersionRow{id:string;document_id:string;revision:number;parent_version_id:string|null;artifact_json:string;note:string;created_at:number;}
/** Authoritative product documents and append-only immutable native references.
 * No native schedule/job/model mutation, content authoring or byte storage. */
export class ArtifactVersions {
  private options:ArtifactVersionsOptions;private db:DatabaseSync;private closed=false;private pending=new Set<Promise<unknown>>();private closing?:Promise<void>;
  constructor(options:ArtifactVersionsOptions){
    check(options.binding?.verified===true&&[options.binding.ownerId,options.binding.sessionId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,512}$/.test(v)),'artifact_version_binding_required',403);
    check(typeof options.assertAuthorized==='function'&&typeof options.resolveArtifact==='function'&&typeof options.downloadArtifact==='function','artifact_version_authority_required',500);
    this.options={...options,binding:{...options.binding}};this.db=options.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifact_documents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL,current_version_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_version_id TEXT,artifact_json TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(document_id,revision),FOREIGN KEY(document_id) REFERENCES artifact_documents(id));
      CREATE TABLE IF NOT EXISTS artifact_version_commands(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(owner_id,session_id,request_key));`);
  }
  private guard(){check(!this.closed,'artifact_version_closed',503);const result:unknown=this.options.assertAuthorized();if(result!==undefined){if(result&&typeof(result as{then?:unknown}).then==='function')void Promise.resolve(result).catch(()=>undefined);throw new ArtifactVersionError('artifact_version_guard_must_be_synchronous',500);}}
  private transaction<T>(operation:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=operation();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private tracked<T>(operation:()=>Promise<T>):Promise<T>{if(this.closed)return Promise.reject(new ArtifactVersionError('artifact_version_closed',503));const call=Promise.resolve().then(operation);this.pending.add(call);void call.then(()=>this.pending.delete(call),()=>this.pending.delete(call));return call;}
  private row(id:string):DocumentRow{check(documentId.test(id),'artifact_version_not_found',404);const b=this.options.binding,row=this.db.prepare('SELECT * FROM artifact_documents WHERE id=? AND owner_id=? AND session_id=?').get(id,b.ownerId,b.sessionId)as unknown as DocumentRow|undefined;check(row,'artifact_version_not_found',404);return row;}
  private document(row:DocumentRow):ArtifactDocumentView{return{id:row.id,title:row.title,revision:row.revision,currentVersionId:row.current_version_id,createdAt:row.created_at,updatedAt:row.updated_at};}
  private version(row:VersionRow):ArtifactVersionView{return{id:row.id,documentId:row.document_id,revision:row.revision,parentVersionId:row.parent_version_id,note:row.note,artifact:JSON.parse(row.artifact_json)as VersionArtifact,createdAt:row.created_at,downloadPath:`/api/artifact-documents/${row.document_id}/versions/${row.id}/content`};}
  private versionRow(doc:string,id:string):VersionRow{this.row(doc);check(versionId.test(id),'artifact_version_not_found',404);const row=this.db.prepare('SELECT * FROM artifact_document_versions WHERE id=? AND document_id=?').get(id,doc)as unknown as VersionRow|undefined;check(row,'artifact_version_not_found',404);return row;}
  private receipt(keyValue:string,fingerprint?:string):ArtifactVersionReceipt|null{const b=this.options.binding,row=this.db.prepare('SELECT payload_fingerprint,receipt_json FROM artifact_version_commands WHERE owner_id=? AND session_id=? AND request_key=?').get(b.ownerId,b.sessionId,keyValue)as{payload_fingerprint:string;receipt_json:string}|undefined;if(!row)return null;if(fingerprint!==undefined)check(row.payload_fingerprint===fingerprint,'artifact_version_request_conflict',409);return JSON.parse(row.receipt_json)as ArtifactVersionReceipt;}
  /** null means no receipt observed now, not proof that an in-flight resolver
   * cannot subsequently commit. Keep the same key until its outcome is known. */
  receiptByKey(keyValue:string){key(keyValue);this.guard();return this.receipt(keyValue);}
  get(id:string){this.guard();return this.document(this.row(id));}
  private page(input:{limit?:number;after?:string}){record(input,[],['limit','after']);const limit=input.limit??artifactVersionLimits.defaultPage;check(Number.isSafeInteger(limit)&&limit>=1&&limit<=artifactVersionLimits.page);return limit;}
  list(input:{limit?:number;after?:string}={}){this.guard();const limit=this.page(input);if(input.after!==undefined)this.row(input.after);const b=this.options.binding,rows=this.db.prepare('SELECT * FROM artifact_documents WHERE owner_id=? AND session_id=? AND id>? ORDER BY id LIMIT ?').all(b.ownerId,b.sessionId,input.after??'',limit+1)as unknown as DocumentRow[];return{documents:rows.slice(0,limit).map(r=>this.document(r)),nextCursor:rows.length>limit?rows[limit-1]!.id:null};}
  history(id:string,input:{limit?:number;after?:string}={}){this.guard();const document=this.document(this.row(id)),limit=this.page(input),after=input.after===undefined?0:this.versionRow(id,input.after).revision;const rows=this.db.prepare('SELECT * FROM artifact_document_versions WHERE document_id=? AND revision>? ORDER BY revision LIMIT ?').all(id,after,limit+1)as unknown as VersionRow[];return{document,versions:rows.slice(0,limit).map(r=>this.version(r)),nextCursor:rows.length>limit?rows[limit-1]!.id:null};}
  private provenance(value:ResolvedVersionArtifact,id:string):VersionArtifact{
    check(value?.sessionId===this.options.binding.sessionId,'artifact_version_resource_scope_denied',403);const a=value.artifact;
    check(a&&a.id===id&&/^[a-f0-9]{64}$/.test(a.sha256)&&typeof a.sourceEventId==='string'&&/^[A-Za-z0-9_.:-]{1,512}$/.test(a.sourceEventId)&&['input','output'].includes(a.origin)&&Number.isSafeInteger(a.sizeBytes)&&a.sizeBytes>=0&&a.sizeBytes<=MAXIMUM_RESOURCE_BYTES&&a.downloadable===true,'artifact_version_resource_invalid',502);
    check(typeof a.name==='string'&&a.name.length>=1&&a.name.length<=200&&!/[\x00-\x1f\x7f]/.test(a.name)&&typeof a.mediaType==='string'&&a.mediaType.length<=128&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.mediaType)&&(a.createdAt===null||(typeof a.createdAt==='string'&&a.createdAt.length<=128))&&a.downloadPath===`/api/artifacts/${id}/content`,'artifact_version_resource_invalid',502);
    return{id:a.id,sessionId:value.sessionId,sourceEventId:a.sourceEventId,sha256:a.sha256,mediaType:a.mediaType,sizeBytes:a.sizeBytes,name:a.name,origin:a.origin,createdAt:a.createdAt};
  }
  private inputCreate(value:CreateArtifactDocumentInput):NormalCreate{const v=record(value,['title','artifactId','idempotencyKey'],['note']);key(v.idempotencyKey);artifactId(v.artifactId);return{title:title(v.title),artifactId:v.artifactId,note:note(v.note),idempotencyKey:v.idempotencyKey};}
  private inputAppend(id:string,value:AppendArtifactVersionInput):NormalAppend{check(documentId.test(id),'artifact_version_not_found',404);const v=record(value,['artifactId','expectedRevision','parentVersionId','idempotencyKey'],['note']);key(v.idempotencyKey);artifactId(v.artifactId);check(Number.isSafeInteger(v.expectedRevision)&&Number(v.expectedRevision)>=1&&typeof v.parentVersionId==='string'&&versionId.test(v.parentVersionId));return{documentId:id,artifactId:v.artifactId,note:note(v.note),expectedRevision:Number(v.expectedRevision),parentVersionId:v.parentVersionId,idempotencyKey:v.idempotencyKey};}
  private head(row:DocumentRow,input:NormalAppend){check(row.revision===input.expectedRevision&&row.current_version_id===input.parentVersionId,'artifact_version_head_conflict',409);check(row.revision<artifactVersionLimits.versions,'artifact_version_limit',409);}
  private saveVersion(row:DocumentRow,resource:VersionArtifact,noteValue:string,parent:string|null):ArtifactVersionView{const v:VersionRow={id:row.current_version_id,document_id:row.id,revision:row.revision,parent_version_id:parent,artifact_json:JSON.stringify(resource),note:noteValue,created_at:row.updated_at};this.db.prepare('INSERT INTO artifact_document_versions VALUES(?,?,?,?,?,?,?)').run(v.id,v.document_id,v.revision,v.parent_version_id,v.artifact_json,v.note,v.created_at);return this.version(v);}
  private saveReceipt(kind:'create'|'append',input:NormalCreate|NormalAppend,fingerprint:string,row:DocumentRow,version:ArtifactVersionView):ArtifactVersionReceipt{const receipt:ArtifactVersionReceipt={command:{id:`doccmd-${randomUUID()}`,key:input.idempotencyKey,kind,payloadFingerprint:fingerprint,input},documentAtAdmission:this.document(row),version};const b=this.options.binding;this.db.prepare('INSERT INTO artifact_version_commands VALUES(?,?,?,?,?,?,?)').run(receipt.command.id,b.ownerId,b.sessionId,input.idempotencyKey,fingerprint,JSON.stringify(receipt),row.updated_at);return receipt;}
  create(value:CreateArtifactDocumentInput){return this.tracked(async()=>{
    const input=this.inputCreate(value),fingerprint=digest(['create',input]);this.guard();const old=this.receipt(input.idempotencyKey,fingerprint);if(old)return old;
    const resource=this.provenance(await this.options.resolveArtifact(input.artifactId),input.artifactId);
    return this.transaction(()=>{this.guard();const replay=this.receipt(input.idempotencyKey,fingerprint);if(replay)return replay;const b=this.options.binding;check(Number((this.db.prepare('SELECT count(*) AS n FROM artifact_documents WHERE owner_id=? AND session_id=?').get(b.ownerId,b.sessionId)as{n:number}).n)<artifactVersionLimits.documents,'artifact_version_limit',409);const now=this.options.now?.()??Date.now();const row:DocumentRow={id:`doc-${randomUUID()}`,owner_id:b.ownerId,session_id:b.sessionId,title:input.title,revision:1,current_version_id:`ver-${randomUUID()}`,created_at:now,updated_at:now};this.db.prepare('INSERT INTO artifact_documents VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.owner_id,row.session_id,row.title,row.revision,row.current_version_id,row.created_at,row.updated_at);return this.saveReceipt('create',input,fingerprint,row,this.saveVersion(row,resource,input.note,null));});
  });}
  append(id:string,value:AppendArtifactVersionInput){return this.tracked(async()=>{
    const input=this.inputAppend(id,value),fingerprint=digest(['append',input]);this.guard();const old=this.receipt(input.idempotencyKey,fingerprint);if(old)return old;this.head(this.row(id),input);
    const resource=this.provenance(await this.options.resolveArtifact(input.artifactId),input.artifactId);
    return this.transaction(()=>{this.guard();const replay=this.receipt(input.idempotencyKey,fingerprint);if(replay)return replay;const prior=this.row(id);this.head(prior,input);const row={...prior,revision:prior.revision+1,current_version_id:`ver-${randomUUID()}`,updated_at:this.options.now?.()??Date.now()};const version=this.saveVersion(row,resource,input.note,prior.current_version_id);this.db.prepare('UPDATE artifact_documents SET revision=?,current_version_id=?,updated_at=? WHERE id=? AND revision=? AND current_version_id=?').run(row.revision,row.current_version_id,row.updated_at,row.id,prior.revision,prior.current_version_id);return this.saveReceipt('append',input,fingerprint,row,version);});
  });}
  downloadVersion(id:string,version:string){return this.tracked(async()=>{this.guard();const saved=this.version(this.versionRow(id,version)),download=await this.options.downloadArtifact(saved.artifact.id);const current=this.provenance(download,saved.artifact.id);check(digest(current)===digest(saved.artifact),'artifact_version_resource_changed',502);check(download.bytes instanceof Uint8Array&&download.bytes.byteLength===saved.artifact.sizeBytes&&createHash('sha256').update(download.bytes).digest('hex')===saved.artifact.sha256,'artifact_version_resource_integrity_failed',502);this.guard();return{version:saved,artifact:{...download.artifact},bytes:download.bytes};});}
  close(){if(this.closing)return this.closing;this.closed=true;this.closing=Promise.allSettled([...this.pending]).then(()=>undefined);return this.closing;}
}
