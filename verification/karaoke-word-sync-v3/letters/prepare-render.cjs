const fs=require('node:fs');
const repo=process.env.REPO_ROOT||'/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct';
const out=process.env.EVIDENCE_DIR||__dirname;
const dataRoot=process.env.V2_EVIDENCE||'/workspace/scratch/513dbcd967bf/deliverables-v2/verification/karaoke-word-sync-v2';
const React=require(repo+'/frontend/node_modules/react');const {renderToStaticMarkup}=require(repo+'/frontend/node_modules/react-dom/server');
const {letterProgress,buildLines}=require(out+'/lyrics-before.cjs');
(async()=>{
 const {KaraokeLyrics}=await import(repo+'/frontend/node_modules/@neo-ui-kit/react/dist/index.js');
 const cleanPath=process.env.CLEAN_DOCUMENT||'/tmp/karaoke-sync-v3/real-audio/generated-documents/clean-entry/lyricsSync.json';
 const clean=JSON.parse(fs.readFileSync(cleanPath,'utf8'));
 const reply=JSON.parse(fs.readFileSync(dataRoot+'/performance/final.json','utf8')).cases.find(x=>x.case==='reply');
 const uk=JSON.parse(fs.readFileSync(dataRoot+'/real-audio/sadvit-current-final.json','utf8')).cases;
 const groups=[{name:'clean',words:clean.words.map(({text,start,end,letters})=>({text,start,end,letters})),lyrics:clean.lyrics,bpm:clean.bpm,sourceOffset:57,lyricsProvenance:cleanPath},
 {name:'reply',words:reply.finalPayload.words,lyrics:reply.lyrics,sourceOffset:reply.sourceOffsetSeconds,lyricsProvenance:'Pinned reply fixture lyrics; no full exported project'},
 ...uk.map(x=>({name:x.case,words:[{...x.finalAbsolute,text:x.text}],lyrics:x.text,sourceOffset:0,lyricsProvenance:'Single-word Ukrainian phrase-tail fixture; full row unavailable'}))];
 const cases=[];const layouts=[];
 for(const group of groups){
  const words=group.words.map((w,index)=>({...w,id:group.name+'-'+index,case:group.name,index,sourceOffset:group.sourceOffset,letters:w.letters.map(t=>(t-w.start)/(w.end-w.start))}));
  const lines=buildLines(words,group.lyrics,group.bpm);layouts.push({case:group.name,sourceOffset:group.sourceOffset,lyrics:group.lyrics,lyricsProvenance:group.lyricsProvenance,lines:lines.map(x=>x.words.map(w=>w.text))});
  for(const line of lines)for(const [targetIndex,w] of line.words.entries())for(const [i,f] of w.letters.entries()){
   if(/[\p{M}\s.,!?;:'’ʼ‘"()\-–—…«»„“”ьъ]/iu.test([...w.text][i]))continue;
   const time=w.start+f*(w.end-w.start);cases.push({word:w,line:line.words,targetIndex,letterIndex:i,time,progress:letterProgress(w,time)});
  }
 }
 const css=fs.readFileSync(repo+'/frontend/node_modules/@neo-ui-kit/react/dist/components/media/KaraokeLyrics/styles.css','utf8');
 const style='@font-face{font-family:Measured;font-weight:800;src:url("file://'+repo+'/frontend/node_modules/@neo-ui-kit/react/dist/fonts/melodix/Melodix-800.woff2")}body{margin:0;background:#000;color:#fff;--ad-font-family-heading:Measured}'+css+' .ad-lyrics-current{font-size:78px;font-family:Measured;font-weight:750;letter-spacing:-.02em}.ad-karaoke-lyrics>p{animation:none}';
 fs.writeFileSync(out+'/renderer-style.css',style);
 const html='<!DOCTYPE html><meta charset="utf-8"><style>'+style+'</style>'+cases.map((c,index)=>renderToStaticMarkup(React.createElement(KaraokeLyrics,{id:`case-${index}`,current:c.line.map(w=>({id:w.id,text:w.text,progress:letterProgress(w,c.time)})),next:[]}))).join('');
 fs.writeFileSync(out+'/render.html',html);fs.writeFileSync(out+'/render-cases.json',JSON.stringify(cases,null,2));fs.writeFileSync(out+'/render-line-contexts.json',JSON.stringify(layouts,null,2));
})();
