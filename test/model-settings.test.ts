import test from 'node:test';import assert from 'node:assert/strict';
import {projectModelSettings,validateModelSelection,buildByokSetup,ModelSettingsError} from '../src/model-settings.ts';
const catalog={auth_accounts:{mine:{config:{label:'My provider',provider:'test',credential_ref:'DO_NOT_EXPOSE'},effective_enabled:true,oauth:false,authenticated:true,headers:{authorization:'SECRET'}}},model_routes:{route:{candidates:[{account:'mine',provider:'test',model:'physical'}]}},credentials:{value:'SECRET'},headers:{foo:'SECRET'}};
test('BYOK view whitelist never returns credentials, provider headers, or raw configuration',()=>{
 const safe=projectModelSettings(catalog,{model:'route',models:['route'],model_options:[{id:'route',label:'My model',extra:'SECRET'}],api_key:'SECRET'});
 assert.equal(safe.accounts[0].state,'configured');assert.equal(safe.probePerformed,false);assert.ok(!JSON.stringify(safe).includes('SECRET'));assert.ok(!JSON.stringify(safe).includes('DO_NOT_EXPOSE'));
});
test('model selection validates current state and configured models',()=>{
 const view=projectModelSettings(catalog,{model:'route',models:['route','other']});
 assert.equal(validateModelSelection(view,{model:'other',expectedCurrent:'route'}).changed,true);
 assert.throws(()=>validateModelSelection(view,{model:'other',expectedCurrent:'stale'}),ModelSettingsError);
 assert.throws(()=>validateModelSelection(view,{model:'unknown',expectedCurrent:'route'}),ModelSettingsError);
});
const input={requestId:'fa7a994a-5241-41b8-8724-581087e6108d',label:'User key',protocol:'openai-chat',baseUrl:'https://provider.example/v1',apiKey:'TEST_ONLY_NEVER_REAL',model:'chosen'};
test('BYOK setup reuses Morphz Secret Store and stable account/route IDs',()=>{
 const a=buildByokSetup(input),b=buildByokSetup(input);assert.deepEqual(a,b);assert.equal(a.body.managed_secret.value,'TEST_ONLY_NEVER_REAL');assert.equal(a.body.account.secret_backend,'morphz_env_file');assert.equal(a.body.route.fallback,false);assert.equal(a.body.provider.protocol,'openai-chat');
});
test('BYOK rejects credential URLs and arbitrary extra fields',()=>{
 for(const baseUrl of ['http://external.example/v1','https://user:pass@example.com','https://example.com?key=secret'])assert.throws(()=>buildByokSetup({...input,baseUrl}),ModelSettingsError);
 assert.throws(()=>buildByokSetup({...input,headers:{authorization:'other'}}),ModelSettingsError);
});

import {ModelSettings} from '../src/model-settings.ts';
test('settings facade only binds a known usable account and never probes provider',async()=>{
 let bound='',selected='',setupCalls=0;
 const settings=new ModelSettings({getProviders:async()=>catalog,getInference:async()=>({model:'route',models:['route','other']}),updateInference:async input=>{selected=input.model;},getAgentProviderBindings:async()=>({revision:1,bindings:bound?[{account_id:bound}]:[]}),bindAgentProviderAccount:async(agent,account)=>{assert.equal(agent,'my-agent');bound=account;},setupProvider:async()=>{setupCalls++;}},'my-agent');
 assert.deepEqual((await settings.read()).binding.accountIds,[]);
 await assert.rejects(settings.bind({accountId:'other-users-account'}),ModelSettingsError);
 await settings.bind({accountId:'mine'});assert.equal(bound,'mine');
 await settings.select({model:'other',expectedCurrent:'route'});assert.equal(selected,'other');
 assert.equal(setupCalls,0);
});
test('stale expectedCurrent cannot bypass model guard when selected model is already current',()=>{const view=projectModelSettings(catalog,{model:'route',models:['route']});assert.throws(()=>validateModelSelection(view,{model:'route',expectedCurrent:'old'}),ModelSettingsError);});
