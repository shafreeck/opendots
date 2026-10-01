/** Authenticated HTTP boundary tests; document/native proofs have separate tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/server.ts';
import {authDigest} from '../src/auth-config.ts';
const documentId='pdoc-11111111-1111-4111-8111-111111111111',versionId='pver-22222222-2222-4222-8222-222222222222';
async function fixture(t:test.TestContext,authenticated=true){
 const root=mkdtempSync(join(tmpdir(),'opendots-authored-http-')),authConfigPath=join(root,'auth.json'),credential='a'.repeat(64);
 writeFileSync(authConfigPath,JSON.stringify({version:1,credential:{kind:'morphz_login_token_sha256',hashHex:authDigest(credential)},sessionTtlSeconds:3600,idleTtlSeconds:600,maximumDevices:8}),{mode:0o600});
 const app=createApplication({dbPath:join(root,'product.db'),baseUrl:'http://127.0.0.1:38888',autoStart:false,...(authenticated?{authConfigPath}:{}),fetch:async()=>{throw Error('Runtime intentionally offline');}});
 await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));await app.ready;const origin=`http://127.0.0.1:${(app.server.address() as any).port}`;
 t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
 let cookie='',csrf=(await(await fetch(origin+'/api/state')).json()).csrfToken;
 if(authenticated){const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({credential,deviceLabel:'Document boundary fixture'})});assert.equal(response.status,200);cookie=response.headers.get('set-cookie')!.split(';')[0]!;csrf=(await response.json()).session.csrfToken;}
 const get=(path:string)=>fetch(origin+path,{headers:{cookie}}),post=(path:string,input:unknown,token=csrf)=>fetch(origin+path,{method:'POST',headers:{origin,cookie,'content-type':'application/json','x-opendots-csrf':token},body:JSON.stringify(input)});
 return {app,origin,get,post};
}
test('authored inventory, version pages and inert exact downloads require owner authentication',async t=>{
 const f=await fixture(t),calls:any[]=[];
 f.app.runtime!.listAuthoredDocuments=(page:any={})=>{calls.push(['list',page]);return{documents:[],nextCursor:null} as any;};
 f.app.runtime!.authoredDocumentHistory=(id:string,page:any={})=>{calls.push(['history',id,page]);return{document:{id},versions:[],nextCursor:null} as any;};
 f.app.runtime!.downloadAuthoredVersion=(id:string,v:string)=>{calls.push(['download',id,v]);return{version:{name:'<unsafe>.md'},bytes:Buffer.from('<script>alert(1)</script>')} as any;};
 for(const path of ['/api/authored-documents',`/api/authored-documents/${documentId}`,`/api/authored-documents/${documentId}/versions/${versionId}/content`])assert.equal((await fetch(f.origin+path)).status,401);
 assert.equal(calls.length,0);assert.equal((await f.get('/api/authored-documents')).status,200);
 assert.equal((await f.post(`/api/authored-documents/${documentId}/versions/page`,{afterId:versionId,limit:1})).status,200);
 assert.deepEqual(calls[1],['history',documentId,{afterId:versionId,limit:1}]);
 const content=await f.get(`/api/authored-documents/${documentId}/versions/${versionId}/content`);assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'application/octet-stream');assert.match(content.headers.get('content-disposition')!,/^attachment;.*%3Cunsafe%3E/);assert.equal(content.headers.get('x-content-type-options'),'nosniff');assert.equal(content.headers.get('cache-control'),'no-store');assert.equal(content.headers.get('content-security-policy'),"sandbox; default-src 'none'");assert.equal(await content.text(),'<script>alert(1)</script>');
 assert.equal((await f.post('/api/authored-documents/page',{},'')).status,403);assert.equal((await f.post('/api/authored-documents/page',{ownerId:'other'})).status,400);
 assert.equal((await f.post('/api/auth/logout',{})).status,200);assert.equal((await f.get('/api/authored-documents')).status,401);
});
test('unauthenticated development mode cannot expose product-authored document history',async t=>{
 const f=await fixture(t,false);f.app.runtime!.listAuthoredDocuments=()=>{throw Error('must not be called');};
 assert.equal((await f.get('/api/authored-documents')).status,403);assert.equal((await f.post('/api/authored-documents/page',{})).status,403);
});
