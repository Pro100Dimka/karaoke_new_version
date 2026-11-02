const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const out=process.env.EVIDENCE_DIR||__dirname;
app.disableHardwareAcceleration();app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{offscreen:true,backgroundThrottling:false}});
 await w.loadFile(out+'/render-final.html');
 const result=await w.webContents.executeJavaScript(`(async()=>{
 const words=[{text:'мо\u0301ре',letters:[0,.1,.7,.7,.8]},{text:'е\u0308лка',letters:[0,.6,.6,.7,.8]}];const result=[];
 for(const w of words){const p=document.createElement('p');p.className='ad-lyrics-current';const e=document.createElement('span');e.className='ad-lyric-word';e.textContent=w.text+' ';p.append(e);document.body.append(p);await document.fonts.ready;const box=e.getBoundingClientRect();const range=document.createRange();const geometry=[...w.text].map((c,i)=>{range.setStart(e.firstChild,i);range.setEnd(e.firstChild,i+1);const r=range.getBoundingClientRect();return[(r.left-box.left)/box.width,(r.right-box.left)/box.width]});result.push({...w,geometry,progress:window.measuredProgress({...w,id:w.text,start:0,end:1},.4,geometry)});p.remove()}return result})()`);
 fs.writeFileSync(out+'/unicode-probe-final.json',JSON.stringify(result,null,2));w.close();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
