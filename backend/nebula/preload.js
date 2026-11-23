const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('fishMemory',{read:()=>ipcRenderer.invoke('nebula:read')});
