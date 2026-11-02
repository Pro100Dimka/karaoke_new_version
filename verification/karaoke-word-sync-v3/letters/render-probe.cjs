const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{offscreen:true}});
 await w.loadURL('data:text/html,<html><body>probe</body></html>');
 const result=await w.webContents.executeJavaScript('({width:document.body.getBoundingClientRect().width, userAgent:navigator.userAgent})');
 fs.writeFileSync('/tmp/karaoke-sync-v3/letters/headless-test.json',JSON.stringify(result));
 w.close();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
