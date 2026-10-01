/** BYOK facade helpers. Reuses Morphz provider/account/model-route contracts and
 * its Secret Store. No second credential database, no automatic provider probe.
 * Field projection follows application/packages/application/src/model-settings.ts
 * at Morphz 7e8f7d81; independently implemented without its UI dependencies.
 */
export class ModelSettingsError extends Error {}
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const entries=(v:unknown)=>Object.entries(object(v));
const short=(v:unknown,fallback='')=>typeof v==='string'?v.slice(0,250):fallback;
export interface ModelSettingsView {
 catalog:{current:string;options:Array<{id:string;label:string}>};
 accounts:Array<{id:string;label:string;kind:'api'|'oauth';state:'configured'|'ready'|'disabled'|'needs-login';models:string[]}>;
 credentialEntry:'user-managed-morphz';
 probePerformed:false;
}
export function projectModelSettings(providers:unknown,inference:unknown):ModelSettingsView {
 const p=object(providers),i=object(inference);
 const options=Array.isArray(i.model_options)?i.model_options.map(object).map(m=>({id:short(m.id),label:short(m.label,short(m.id))})).filter(m=>m.id):
   (Array.isArray(i.models)?i.models:[]).filter((m:unknown)=>typeof m==='string').map((m:string)=>({id:short(m),label:short(m)}));
 return {
  catalog:{current:short(i.model),options},
  accounts:entries(p.auth_accounts).map(([id,raw])=>{
   const a=object(raw),config=object(a.config);const models=new Set<string>();
   for(const [,route]of entries(p.model_routes))for(const c of Array.isArray(route.candidates)?route.candidates:[]){if(c.account===id||(!c.account&&c.provider===config.provider))if(typeof c.model==='string')models.add(short(c.model));}
   return {id:short(id),label:short(config.label,a.oauth?'Subscription account':'API connection'),kind:a.oauth?'oauth' as const:'api' as const,state:a.effective_enabled===false?'disabled' as const:a.oauth?(a.authenticated?'ready' as const:'needs-login' as const):'configured' as const,models:[...models].sort()};
  }),credentialEntry:'user-managed-morphz',probePerformed:false,
 };
}
export function validateModelSelection(view:ModelSettingsView,input:unknown){
 const a=object(input);
 if(Object.keys(a).some(k=>!['model','expectedCurrent'].includes(k))||typeof a.model!=='string'||typeof a.expectedCurrent!=='string')throw new ModelSettingsError('Invalid model selection');
 if(a.expectedCurrent!==view.catalog.current)throw new ModelSettingsError('Model settings changed; refresh before saving');
 if(a.model===view.catalog.current)return {model:a.model,changed:false};
 if(!view.catalog.options.some(m=>m.id===a.model))throw new ModelSettingsError('Model is not configured');
 return {model:a.model,changed:true};
}
export interface ByokInput { requestId:string;label:string;protocol:'openai-responses'|'openai-chat'|'anthropic-messages'|'gemini-content';baseUrl:string;apiKey:string;model:string; }
/** Use only on a protected user-entry route. Never audit/log returned body.
 * It goes directly to Morphz PUT /api/runtime/providers/setup; Morphz owns storage.
 */
export function buildByokSetup(input:unknown){
 const a=object(input);
 const allowed=['requestId','label','protocol','baseUrl','apiKey','model'];
 if(Object.keys(a).some(k=>!allowed.includes(k))||!allowed.every(k=>typeof a[k]==='string'))throw new ModelSettingsError('Invalid BYOK configuration');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(a.requestId))throw new ModelSettingsError('A stable request UUID is required');
 if(!['openai-responses','openai-chat','anthropic-messages','gemini-content'].includes(a.protocol))throw new ModelSettingsError('Unsupported provider protocol');
 if(!a.apiKey.trim()||a.apiKey.length>16384||!a.label.trim()||a.label.length>100||!a.model.trim()||a.model.length>250)throw new ModelSettingsError('Invalid BYOK field length');
 let endpoint:URL;try{endpoint=new URL(a.baseUrl);}catch{throw new ModelSettingsError('Invalid API endpoint');}
 if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!(endpoint.protocol==='https:'||(endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))))throw new ModelSettingsError('API endpoint requires HTTPS, except loopback, and cannot contain credentials or query parameters');
 const provider=`opendots-${a.requestId}`,account=`${provider}-account`,credential=`${provider}-key`,route=`${provider}-model`,name=`OPENDOTS_API_${a.requestId.replaceAll('-','_').toUpperCase()}`;
 return {accountId:account,routeId:route,body:{
  provider_id:provider,provider:{adapter:a.protocol.startsWith('openai-')?'openai-compatible':'protocol-compatible',protocol:a.protocol,base_url:endpoint.toString().replace(/\/$/,''),accounts:[account],models:{[a.model]:{}},headers:{},env_headers:{}},
  account_id:account,account:{auth_adapter:'credential',credential_ref:credential,secret_backend:'morphz_env_file',provider,label:a.label,enabled:true},
  credential_id:credential,credential:{source:'env',name,service:null,command:[]},
  managed_secret:{name,value:a.apiKey,scope_kind:'runtime',value_backend:'morphz_env_file'},
  route_id:route,route:{display_alias:`${a.model} · ${a.label}`,aliases:[`${a.model} · ${a.label}`],candidates:[{provider,model:a.model,priority:0,account,capabilities:[]}],affinity:'context',selection:'available-least-recently-used',fallback:false}
 }};
}

export interface ModelSettingsAdapter {
 getProviders():Promise<unknown>;
 getInference():Promise<unknown>;
 updateInference(input:{model:string;reasoning_effort?:string}):Promise<unknown>;
 getAgentProviderBindings(agentId:string):Promise<unknown>;
 bindAgentProviderAccount(agentId:string,accountId:string):Promise<unknown>;
 setupProvider?(body:unknown):Promise<unknown>;
}
export class ModelSettings {
 private busy=false;
 private adapter:ModelSettingsAdapter;
 private agentId:string;
 constructor(adapter:ModelSettingsAdapter,agentId:string){this.adapter=adapter;this.agentId=agentId;}
 async read(){
  const [providers,inference,bindings]=await Promise.all([this.adapter.getProviders(),this.adapter.getInference(),this.adapter.getAgentProviderBindings(this.agentId)]);
  const b=object(bindings);
  return {...projectModelSettings(providers,inference),binding:{accountIds:(Array.isArray(b.bindings)?b.bindings:[]).map(object).map(x=>short(x.account_id)).filter(Boolean),revision:Number.isSafeInteger(b.revision)?b.revision:null}};
 }
 private async change<T>(fn:()=>Promise<T>){if(this.busy)throw new ModelSettingsError('Another model settings change is pending');this.busy=true;try{return await fn();}finally{this.busy=false;}}
 async select(input:{model:string;expectedCurrent:string;reasoningEffort?:string}){
  return this.change(async()=>{
   const inference=object(await this.adapter.getInference()),providers=await this.adapter.getProviders();
   const change=validateModelSelection(projectModelSettings(providers,inference),{model:input.model,expectedCurrent:input.expectedCurrent});
   if(input.reasoningEffort!==undefined){const option=(Array.isArray(inference.model_options)?inference.model_options:[]).find((x:any)=>x.id===input.model);if(!Array.isArray(option?.supported_reasoning_efforts)||!option.supported_reasoning_efforts.includes(input.reasoningEffort))throw new ModelSettingsError('Reasoning effort is not supported by this model');}
   if(change.changed||input.reasoningEffort!==undefined)await this.adapter.updateInference({model:input.model,...(input.reasoningEffort?{reasoning_effort:input.reasoningEffort}:{})});
   return this.read();
  });
 }
 async bind(input:{accountId:string}){
  return this.change(async()=>{
   const view=await this.read();const account=view.accounts.find(a=>a.id===input.accountId);
   if(!account||account.state==='disabled'||account.state==='needs-login')throw new ModelSettingsError('Account is not available for this assistant');
   await this.adapter.bindAgentProviderAccount(this.agentId,account.id);return this.read();
  });
 }
 async connect(input:unknown){
  return this.change(async()=>{
   if(!this.adapter.setupProvider)throw new ModelSettingsError('Runtime provider setup is unavailable');
   const setup=buildByokSetup(input);
   try{await this.adapter.setupProvider(setup.body);}catch{throw new ModelSettingsError('Provider configuration outcome is unconfirmed. Refresh before retrying with the same request ID.');}
   return {...await this.read(),createdAccountId:setup.accountId,createdRouteId:setup.routeId};
  });
 }
}
