import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {canonicalPublicOrigin} from '../src/application-origin.ts';
const require=createRequire(import.meta.url);
const {originFromArgs,assertSafeCommandLine,trustedNavigation,trustedResource,secureSession,secureContents,webPreferences}=require('../apps/desktop/security.cjs');
const origin='http://127.0.0.1:3210';
test('desktop preserves numeric loopback default and refuses unsafe HTTP origins',()=>{assert.equal(originFromArgs([]),origin);assert.equal(originFromArgs(['--opendots-origin=http://127.0.0.1:4567/']),'http://127.0.0.1:4567');for(const v of ['','http://example.com','http://localhost:3210','http://127.1:3210','http://2130706433:3210','http://127.0.0.1:3210?token=x','http://u:p@127.0.0.1:3210','http://127.0.0.1:3210/path','http://127.0.0.1:80'])assert.throws(()=>originFromArgs(['--opendots-origin='+v]));assert.throws(()=>originFromArgs(['--no-sandbox']));assert.throws(()=>originFromArgs(['--opendots-origin='+origin,'--opendots-origin='+origin]));});

test('desktop explicit HTTPS parser matches the canonical BFF policy',()=>{
  for(const value of ['https://dots.example','https://dots.example/','https://dots.example:443/','https://dots.example:8443','https://[2001:db8::1]:443/','https://xn--bcher-kva.example','https://127.0.0.1:3210'])assert.equal(originFromArgs(['--opendots-origin='+value]),canonicalPublicOrigin(value));
  for(const value of ['https://DOTS.example','HTTPS://dots.example','https://dots.example.','https://dots.example?','https://dots.example#','https://@dots.example','https://u:p@dots.example','https://dots.example/a/..','https://dots.example\\','https://%64ots.example','https://dots.example:0443','https://dots.example:0','https://dots.example:65536','https://127.1','https://0x7f000001','https://0.0.0.0','https://[::]','https://bad_host.example','https://*.example','https://bücher.example']){assert.throws(()=>canonicalPublicOrigin(value));assert.throws(()=>originFromArgs(['--opendots-origin='+value]));}
});

test('desktop refuses alternate Chromium switch prefixes and normalized certificate exceptions before startup',()=>{
  const flags=['no-sandbox','disable-web-security','remote-debugging-port','remote-debugging-pipe','ignore-certificate-errors','ignore-certificate-errors-spki-list','allow-insecure-localhost','allow-running-insecure-content','unsafely-treat-insecure-origin-as-secure'];
  for(const name of flags){
    for(const prefix of ['--','-','/'])for(const suffix of ['','=synthetic-value'])assert.throws(()=>originFromArgs(['--opendots-origin=https://dots.example',prefix+name+suffix]),/Unsafe Chromium/);
    assert.throws(()=>assertSafeCommandLine({hasSwitch:(value:string)=>value===name}),/Unsafe Chromium/);
  }
  assert.doesNotThrow(()=>assertSafeCommandLine({hasSwitch:()=>false}));
  assert.throws(()=>assertSafeCommandLine(undefined),/Unsafe Chromium/);
  const calls:string[]=[];
  runInNewContext(readFileSync(new URL('../apps/desktop/main.cjs',import.meta.url),'utf8'),{
    require:(name:string)=>name==='electron'?{app:{commandLine:{hasSwitch:(value:string)=>value==='ignore-certificate-errors-spki-list'},exit:(code:number)=>calls.push('exit:'+code),enableSandbox:()=>calls.push('sandbox'),whenReady:()=>{calls.push('ready');return Promise.resolve();}},BrowserWindow:()=>calls.push('window')} :name==='./security.cjs'?require('../apps/desktop/security.cjs'):name==='./capabilities.cjs'?{}:null,
    process:{argv:['electron','main.cjs','--opendots-origin=https://dots.example']},console:{error:()=>{}},
  });
  assert.deepEqual(calls,['exit:1']);
});

test('desktop HTTPS resource policy permits only matching WSS and keeps mixed content closed',()=>{
  const remote='https://dots.example';
  assert.equal(trustedNavigation(remote+'/login',remote),true);
  assert.equal(trustedResource(remote+'/api/state',remote),true);
  assert.equal(trustedResource('wss://dots.example/api/computer/stream',remote),true);
  assert.equal(trustedResource('blob:'+remote+'/audio-id',remote),true);
  for(const value of ['http://dots.example/api/state','ws://dots.example/api/computer/stream','wss://dots.example:443/api/computer/stream','wss://dots.example/api/computer/stream?ticket=x','wss://dots.example/api/computer/stream#','wss://other.example/api/computer/stream','wss://dots.example/other'])assert.equal(trustedResource(value,remote),false,value);
  const handlers:any={};secureSession({setPermissionCheckHandler(){},setPermissionRequestHandler(){},setDevicePermissionHandler(){},on(){},webRequest:{onBeforeRequest:(fn:any)=>handlers.network=fn}},remote);
  handlers.network({url:'ws://dots.example/api/computer/stream'},(r:any)=>assert.equal(r.cancel,true));
});
test('desktop navigation and resource policy reject external destinations',()=>{assert.equal(trustedNavigation(origin+'/#tasks',origin),true);assert.equal(trustedNavigation(origin+'/login',origin),true);assert.equal(trustedNavigation(origin+'/login?next=https://example.com',origin),false);for(const path of ['/api/state','/?token=x'])assert.equal(trustedNavigation(origin+path,origin),false);for(const url of ['file:///etc/passwd','https://example.com/','http://127.0.0.1:9999/','javascript:alert(1)','http://u:p@127.0.0.1:3210/','ws://127.0.0.1:3210/other'])assert.equal(trustedResource(url,origin),false);assert.equal(trustedResource(origin+'/app.js',origin),true);assert.equal(trustedResource('ws://127.0.0.1:3210/api/computer/stream',origin),true);assert.equal(trustedResource('blob:'+origin+'/id',origin),true);assert.equal(trustedResource('blob:https://example.com/id',origin),false);});
test('desktop renderer is sandboxed with no Node or privileged bridge',()=>{assert.equal(webPreferences.sandbox,true);assert.equal(webPreferences.contextIsolation,true);assert.equal(webPreferences.webSecurity,true);for(const key of ['nodeIntegration','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webviewTag','allowRunningInsecureContent','experimentalFeatures','devTools'])assert.equal(webPreferences[key],false);assert.equal(webPreferences.preload,undefined);});
test('desktop injected session denies permissions, devices, downloads and external requests',()=>{const handlers:any={};secureSession({setPermissionCheckHandler:(fn:any)=>handlers.check=fn,setPermissionRequestHandler:(fn:any)=>handlers.request=fn,setDevicePermissionHandler:(fn:any)=>handlers.device=fn,on:(name:string,fn:any)=>handlers[name]=fn,webRequest:{onBeforeRequest:(fn:any)=>handlers.network=fn}},origin);assert.equal(handlers.check(),false);assert.equal(handlers.device(),false);let allowed=true;handlers.request(null,'media',(value:boolean)=>allowed=value);assert.equal(allowed,false);let canceled=false;handlers['will-download']({preventDefault(){canceled=true}});assert.equal(canceled,true);handlers.network({url:'https://example.com/'},(r:any)=>assert.equal(r.cancel,true));});
test('desktop injected contents rejects popups, untrusted frames and webviews',()=>{const handlers:any={};secureContents({setWindowOpenHandler:(fn:any)=>handlers.open=fn,on:(n:string,fn:any)=>handlers[n]=fn},origin);assert.deepEqual(handlers.open(),{action:'deny'});let count=0;const event={preventDefault(){count++}};handlers['will-navigate']({...event,url:'https://example.com'});handlers['will-redirect']({...event,url:'file:///tmp/test'});handlers['will-frame-navigate']({...event,isMainFrame:false,url:origin});handlers['will-attach-webview'](event);assert.equal(count,4);handlers['will-navigate']({...event,url:origin+'/#chat'});handlers['will-frame-navigate']({...event,isMainFrame:true,url:origin+'/#tasks'});assert.equal(count,4);});

test('desktop permits exact authentication redirect and return without widening navigation',()=>{const handlers:any={};secureContents({setWindowOpenHandler(){},on:(n:string,fn:any)=>handlers[n]=fn},origin);let denied=0;const preventDefault=()=>denied++;handlers['will-redirect']({url:origin+'/login',preventDefault});handlers['will-navigate']({url:origin+'/',preventDefault});assert.equal(denied,0);handlers['will-redirect']({url:origin+'/login/other',preventDefault});assert.equal(denied,1);});
