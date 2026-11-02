const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const crypto=require('node:crypto');const out=process.env.EVIDENCE_DIR||__dirname;
const mode=process.argv.at(-1)==='after'?'after':'before';app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{offscreen:true,backgroundThrottling:false}});
 const cases=JSON.parse(fs.readFileSync(out+'/render-cases.json','utf8'));
 await w.loadFile(out+(mode==='after'?'/render-final.html':'/render.html'));
 if(mode==='after')await w.webContents.executeJavaScript(`window.replayCases(${JSON.stringify(cases)})`);
 await w.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
 const result=await w.webContents.executeJavaScript(`(${function(cases){return cases.map((c,i)=>{
  const el=document.querySelectorAll('#case-'+i+' .ad-lyric-word')[c.targetIndex];const node=el.firstChild;const box=el.getBoundingClientRect();const range=document.createRange();
  let offset=0;const geometry=[...c.word.text].map(character=>{range.setStart(node,offset);offset+=character.length;range.setEnd(node,offset);const r=range.getBoundingClientRect();return [(r.left-box.left)/box.width,(r.right-box.left)/box.width]});
  const fill=parseFloat(getComputedStyle(el).getPropertyValue('--ad-lyric-fill'));
  return {...c,rectCount:el.getClientRects().length,rects:Array.from(el.getClientRects(),r=>({left:r.left,top:r.top,width:r.width,height:r.height})),width:box.width,geometry,fillPercent:fill,fillX:box.width*fill/100,glyphBoundaryX:geometry[c.letterIndex][0]*box.width,errorPx:box.width*(fill/100-geometry[c.letterIndex][0]),font:getComputedStyle(el).font};
 })}.toString()})(${JSON.stringify(cases)})`);
 const repo=process.env.REPO_ROOT||'/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct';
 const files=['frontend/src/features/karaoke/karaokeLyrics.ts','frontend/src/features/karaoke/useLyricFill.ts','frontend/src/features/karaoke/KaraokeStage.tsx'];
 const sourceHashes=Object.fromEntries(files.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(repo+'/'+p)).digest('hex')]));
 fs.writeFileSync(out+'/render-'+mode+'-all.json',JSON.stringify({createdAtUtc:new Date().toISOString(),mode,renderer:process.versions,workingSourceHashesAtMeasurement:sourceHashes,executedInterpolationSourceSha256:crypto.createHash('sha256').update(fs.readFileSync(mode==='after'?repo+'/frontend/src/features/karaoke/karaokeLyrics.ts':out+'/lyrics-before.cjs')).digest('hex'),results:result},null,2));
 if(mode==='after'){const cost=await w.webContents.executeJavaScript(`window.probeRenderCost(${JSON.stringify(cases[0].word)})`);fs.writeFileSync(out+'/render-cost.json',JSON.stringify(cost,null,2));}w.close();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
