/** Read-only inspection of existing Morphz Frames. Memory is managed by Morphz
 * through ordinary conversation; no manual Frame editor or Runtime extension.
 */
export interface MemoryAdapter {
 searchRecall(contextId:string,query:string,cursor?:string):Promise<unknown>;
 recallFrame(contextId:string,frameId:string):Promise<unknown>;
}
export class MemoryViewError extends Error {}
const rec=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):string=>{if(typeof v!=='string'||!v||v.length>512||v.includes('\0'))throw new MemoryViewError('Invalid Frame identity');return v;};
export class MemoryView {
 private adapter:MemoryAdapter;private contextId:string;private sessionId:string;
 constructor(adapter:MemoryAdapter,contextId:string,sessionId:string){this.adapter=adapter;this.contextId=contextId;this.sessionId=sessionId;}
 async search(query:string,cursor?:string){
  if(typeof query!=='string'||!query.trim()||query.length>1000||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>4096))throw new MemoryViewError('Enter a memory search query');
  const page=rec(await this.adapter.searchRecall(this.contextId,query,cursor));
  if(page.context_id!==this.contextId||!Array.isArray(page.matches))throw new MemoryViewError('Memory result is outside the assistant Context');
  return {query,frames:page.matches.filter((m:any)=>m.document_kind==='frame').map((m:any)=>({id:id(m.document_id),revision:m.revision,retired:m.retired===true,preview:typeof m.preview==='string'?m.preview:'',source:'morphz-frame'})),nextCursor:typeof page.next_cursor==='string'?page.next_cursor:null,capabilities:{read:true,edit:false,forget:false}};
 }
 async read(frameId:string){
  id(frameId);const page=rec(await this.adapter.recallFrame(this.contextId,frameId));
  if(page.root_frame_id!==frameId||!Number.isSafeInteger(page.mind_version)||!Array.isArray(page.nodes))throw new MemoryViewError('Invalid Frame response');
  const node=page.nodes.find((n:any)=>n.kind==='frame'&&n.id===frameId);
  if(!node)throw new MemoryViewError('Frame body is not available');
  return {id:frameId,revision:node.revision,mindVersion:page.mind_version,lifecycle:node.lifecycle,body:typeof node.body==='string'?node.body:'',sources:Array.isArray(node.sources)?node.sources.filter((s:any)=>typeof s==='string'):[],truncated:page.truncated===true,capabilities:{read:true,edit:false,forget:false}};
 }
}
