'use strict';
const {app,BrowserWindow,session,dialog,Menu,systemPreferences}=require('electron');
const {webPreferences,originFromArgs,assertSafeCommandLine,secureSession,secureContents}=require('./security.cjs');
const {createCapabilities}=require('./capabilities.cjs');
let origin;
try{assertSafeCommandLine(app.commandLine);origin=originFromArgs(process.argv.slice(1));}catch(error){console.error(error.message);app.exit(1);}
if(origin){
  app.enableSandbox();
  let window=null;
  app.on('certificate-error',(event,_contents,_url,_error,_certificate,callback)=>{event.preventDefault();callback(false);});
  app.on('login',event=>event.preventDefault());
  app.whenReady().then(async()=>{
    assertSafeCommandLine(app.commandLine);
    Menu.setApplicationMenu(null);
    // No persist: prefix: cookies and browser storage last only for this process.
    const isolated=session.fromPartition('opendots-desktop',{cache:false});
    window=new BrowserWindow({width:1320,height:900,minWidth:760,minHeight:580,title:'opendots',backgroundColor:'#f6f7f4',show:false,webPreferences:{...webPreferences,session:isolated}});
    const capabilities=createCapabilities({window,session:isolated,dialog,systemPreferences,origin});
    secureSession(isolated,origin,capabilities);
    secureContents(window.webContents,origin);
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'opendots',submenu:[{label:'撤销麦克风并关闭窗口',click:()=>{capabilities.revokeMicrophone();window?.destroy();}},{label:'取消正在保存的成果',click:()=>capabilities.cancelDownload()},{type:'separator'},{role:'quit',label:'退出'}]}]));
    window.once('ready-to-show',()=>window?.show());
    window.on('closed',()=>{window=null;});
    try{await window.loadURL(origin+'/');}catch{
      if(window&&!window.isDestroyed()){dialog.showErrorBox('opendots 未连接','请确认配置的 opendots 服务可用；HTTPS 入口还需要有效的受信任证书。确认后重新打开客户端。');window.close();}
    }
  }).catch(()=>{dialog.showErrorBox('opendots 启动失败','无法初始化隔离窗口。请检查 Electron 与系统图形环境。');app.quit();});
  app.on('window-all-closed',()=>app.quit());
}
