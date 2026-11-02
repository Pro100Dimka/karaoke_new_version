const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const out='/tmp/karaoke-sync-v3/letters';
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{offscreen:true}});
 await w.loadFile(out+'/render.html');
 await w.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
 const cases=JSON.parse(fs.readFileSync(out+'/render-cases.json','utf8'));
 const result=await w.webContents.executeJavaScript(`(${function(cases){
  return cases.map((c,i)=>{
   const el=document.querySelector('#case-'+i+' .ad-lyric-word');const node=el.firstChild;const box=el.getBoundingClientRect(); const range=document.createRange();
   range.setStart(node,c.letterIndex);range.setEnd(node,c.letterIndex);
   const edge=range.getBoundingClientRect(); const fill=parseFloat(getComputedStyle(el).getPropertyValue('--ad-lyric-fill'));
   const textRange=document.createRange();textRange.selectNodeContents(el);textRange.setEnd(node,c.word.text.length);const textWidth=textRange.getBoundingClientRect().width;
   return {...c,width:box.width,textWidth,glyphBoundaryX:edge.left-box.left,fillPercent:fill,fillX:box.width*fill/100,errorPx:box.width*fill/100-(edge.left-box.left),font:getComputedStyle(el).font};
  })
 }.toString()})(${JSON.stringify(cases)})`);
 fs.writeFileSync(out+'/render-before.json',JSON.stringify({renderer:process.versions,results:result},null,2));
 w.close();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
