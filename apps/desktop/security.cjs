'use strict';
const webPreferences=Object.freeze({nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,experimentalFeatures:false,devTools:false});
const unsafeSwitches=Object.freeze(['no-sandbox','disable-setuid-sandbox','disable-gpu-sandbox','disable-web-security','remote-debugging-port','remote-debugging-pipe','ignore-certificate-errors','ignore-certificate-errors-spki-list','allow-insecure-localhost','allow-running-insecure-content','unsafely-treat-insecure-origin-as-secure']);
function assertSafeCommandLine(commandLine){
  if(!commandLine||typeof commandLine.hasSwitch!=='function'||unsafeSwitches.some(name=>commandLine.hasSwitch(name)))throw new Error('Unsafe Chromium flags are not supported.');
}
// Mirror application-origin.ts's configuration-only HTTPS parser. Keep this
// dependency-free CJS entry usable by Electron; parity is covered by tests.
function canonicalHttpsOrigin(value){
  const invalid=()=>{throw new Error('Use a canonical HTTPS origin without credentials, paths, queries or fragments.');};
  if(typeof value!=='string'||value.length<9||value.length>2048||/[^\x21-\x7e]/.test(value))invalid();
  let u;try{u=new URL(value);}catch{invalid();}
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)invalid();
  const bare=value.endsWith('/')?value.slice(0,-1):value;
  if(bare!==u.origin&&!(u.port===''&&bare===`https://${u.hostname}:443`))invalid();
  if(u.port&&(!/^[1-9][0-9]{0,4}$/.test(u.port)||Number(u.port)>65535))invalid();
  if(!u.hostname.startsWith('[')&&(u.hostname.length>253||!u.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))invalid();
  if(u.hostname==='0.0.0.0'||u.hostname==='[::]')invalid();
  return u.origin;
}
function originFromArgs(args){
  // Chromium accepts '-' as well as '--', and '/' on Windows. Reject these
  // spellings here and check normalized app.commandLine separately at startup.
  if(args.some(a=>{const flag=/^(?:--?|\/)([^=]+)(?:=|$)/.exec(a);return flag&&unsafeSwitches.includes(flag[1].toLowerCase());}))throw new Error('Unsafe Chromium flags are not supported.');
  const values=args.filter(a=>a.startsWith('--opendots-origin='));
  if(values.length>1)throw new Error('Specify one opendots origin.');
  const raw=values[0]===undefined?'http://127.0.0.1:3210':values[0].slice('--opendots-origin='.length);
  if(raw.startsWith('https:'))return canonicalHttpsOrigin(raw);
  const u=new URL(raw);
  // Require the literal loopback spelling as well as parsed hostname: no DNS or shorthand IPs.
  if(!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(raw)||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||Number(u.port)<1024||Number(u.port)>65535)throw new Error('Use an explicit http://127.0.0.1:<port> origin, without credentials or paths.');
  return u.origin;
}
function trustedNavigation(value,origin){try{const u=new URL(value);return u.origin===origin&&!u.username&&!u.password&&['/','/index.html','/login'].includes(u.pathname)&&!u.search;}catch{return false;}}
function trustedResource(value,origin){try{const u=new URL(value);if(u.username||u.password)return false;if(u.protocol==='blob:')return u.origin===origin;if(u.origin===origin)return true;const target=new URL(origin);return value===`${target.protocol==='https:'?'wss:':'ws:'}//${target.host}/api/computer/stream`;}catch{return false;}}
function secureSession(session,origin,capabilities){
  session.setPermissionCheckHandler(()=>false);
  session.setPermissionRequestHandler(capabilities?.permissionRequest??((_contents,_permission,callback)=>callback(false)));
  session.setDevicePermissionHandler(()=>false);
  session.on('will-download',capabilities?.willDownload??((event)=>event.preventDefault()));
  session.webRequest.onBeforeRequest((details,callback)=>{capabilities?.observeRequest(details);callback({cancel:!trustedResource(details.url,origin)});});
  if(capabilities)session.webRequest.onHeadersReceived((details,callback)=>{capabilities.observeResponse(details);callback({});});
}
function secureContents(contents,origin){
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  for(const name of ['will-navigate','will-redirect'])contents.on(name,event=>{if(!trustedNavigation(event.url,origin))event.preventDefault();});
  contents.on('will-frame-navigate',event=>{if(!event.isMainFrame||!trustedNavigation(event.url,origin))event.preventDefault();});
  contents.on('will-attach-webview',event=>event.preventDefault());
}
module.exports={webPreferences,originFromArgs,assertSafeCommandLine,trustedNavigation,trustedResource,secureSession,secureContents};
