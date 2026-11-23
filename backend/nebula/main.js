// Separate, on-demand window. Opening it does not start the pet or its service.
const {app,BrowserWindow,ipcMain,session} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {getUserDataRoot} = require('../electron/user-data');
const {snapshot} = require('./snapshot');
const root=path.resolve(__dirname,'../..');
const profileKey=require('node:crypto').createHash('sha256').update(getUserDataRoot()).digest('hex').slice(0,12);
const directory=path.join(root,'temp','nebula-window-'+profileKey);
fs.mkdirSync(directory,{recursive:true});
app.setPath('userData',directory);
app.setPath('sessionData',directory);
app.setPath('crashDumps',directory);
app.setName('大肥鱼 · 记忆星云');
app.commandLine.appendSwitch('disable-http-cache');
let viewer;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(viewer){if(viewer.isMinimized())viewer.restore();viewer.show();viewer.focus();}});
  app.whenReady().then(()=>{
    const partition=session.fromPartition('memory-nebula',{cache:false});
    const page=pathToFileURL(path.join(__dirname,'index.html')).href;
    partition.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
    partition.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,reply)=>reply({cancel:true}));
    viewer=new BrowserWindow({width:1420,height:840,minWidth:640,minHeight:480,show:false,
      backgroundColor:'#070b15',autoHideMenuBar:true,title:'大肥鱼 · 记忆星云',icon:path.join(root,'desktop/resources/icon.ico'),
      webPreferences:{session:partition,preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    viewer.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    viewer.webContents.on('will-navigate',event=>event.preventDefault());
    ipcMain.handle('nebula:read',event=>{
      if(event.sender!==viewer?.webContents || event.senderFrame?.url!==page) return {status:'unavailable',nodes:[]};
      try{return snapshot(path.join(getUserDataRoot(),'companion-memory.db'));}
      catch{return {status:'unavailable',nodes:[]};}
    });
    viewer.once('ready-to-show',()=>viewer.show());
    viewer.on('closed',()=>{viewer=null;});
    viewer.loadURL(page);
  });
  app.on('window-all-closed',()=>app.quit());
}
