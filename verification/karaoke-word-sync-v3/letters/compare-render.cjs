// Numerical renderer error relative to saved model timestamps, not human phoneme ground truth.
const fs=require('node:fs');const crypto=require('node:crypto');
const repo=process.env.REPO_ROOT||'/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct';
const out=process.env.EVIDENCE_DIR||__dirname;
require(repo+'/frontend/node_modules/esbuild').buildSync({entryPoints:[repo+'/frontend/src/features/karaoke/karaokeLyrics.ts'],outfile:out+'/lyrics-final.cjs',bundle:true,platform:'node',format:'cjs'});
const old=require(out+'/lyrics-before.cjs').letterProgress;const final=require(out+'/lyrics-final.cjs').letterProgress;
const before=JSON.parse(fs.readFileSync(out+'/render-before-all.json','utf8'));const after=JSON.parse(fs.readFileSync(out+'/render-after-all.json','utf8'));
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2};
function crossing(word,target,progress){let a=word.start,b=word.end;for(let i=0;i<60;i++){const t=(a+b)/2;if(progress(t)>=target)b=t;else a=t}return b}
const letters=after.results.map((r,i)=>{
 const b=before.results[i];if(r.word.id!==b.word.id||r.letterIndex!==b.letterIndex)throw Error('Mismatched render cases');
 const target=r.geometry[r.letterIndex][0];
 const previousTime=crossing(r.word,target,t=>Math.round(old(r.word,t)*100)/100);
 const currentTime=crossing(r.word,target,t=>final(r.word,t,r.geometry));
 return {case:r.word.case,index:r.word.index,text:r.word.text,letterIndex:r.letterIndex,letter:[...r.word.text][r.letterIndex],savedTime:r.time,oldVisualBoundaryTime:previousTime,finalVisualBoundaryTime:currentTime,oldErrorMs:(previousTime-r.time)*1000,finalErrorMs:(currentTime-r.time)*1000,oldErrorPx:b.errorPx,finalErrorPx:r.errorPx};
});
const words=[];const seen=new Set();
for(const r of after.results){if(seen.has(r.word.id))continue;seen.add(r.word.id);
 const rows=letters.filter(x=>x.case===r.word.case&&x.index===r.word.index);const chars=[...r.word.text];let last=chars.length-1;while(last>=0&&/[\s.,!?;:'’ʼ‘"()\-–—…«»„“”]/.test(chars[last]))last--;
 const target=r.geometry[last][1];const previousTime=crossing(r.word,target,t=>Math.round(old(r.word,t)*100)/100);const currentTime=crossing(r.word,target,t=>final(r.word,t,r.geometry));
 const worst=rows.reduce((a,b)=>Math.abs(a.oldErrorMs)>=Math.abs(b.oldErrorMs)?a:b);
 words.push({case:r.word.case,index:r.word.index,text:r.word.text,start:r.word.start,end:r.word.end,letters:r.word.letters.map(f=>r.word.start+f*(r.word.end-r.word.start)),oldMaxInternalErrorMs:Math.max(...rows.map(x=>Math.abs(x.oldErrorMs))),oldWorstLetter:worst.letter,oldWorstSignedErrorMs:worst.oldErrorMs,finalMaxInternalErrorMs:Math.max(...rows.map(x=>Math.abs(x.finalErrorMs))),oldVisibleEnd:previousTime,finalVisibleEnd:currentTime,oldVisibleEndErrorMs:(previousTime-r.word.end)*1000,finalVisibleEndErrorMs:(currentTime-r.word.end)*1000});
}
const internal=letters.filter(x=>x.letterIndex>0);
const metrics={
 scope:'Error of mapping saved letter timestamps to rendered glyph-advance boundaries in the shipped Electron component; not acoustic accuracy, display latency, human review or frame presentation accuracy.',
 wordCount:words.length,letterBoundaryCount:letters.length,internalBoundaryCount:internal.length,
 oldPixelError:{median:median(internal.map(x=>Math.abs(x.oldErrorPx))),max:Math.max(...internal.map(x=>Math.abs(x.oldErrorPx)))},
 finalPixelError:{median:median(internal.map(x=>Math.abs(x.finalErrorPx))),max:Math.max(...internal.map(x=>Math.abs(x.finalErrorPx)))},
 oldInternalTimeErrorMs:{median:median(internal.map(x=>Math.abs(x.oldErrorMs))),max:Math.max(...internal.map(x=>Math.abs(x.oldErrorMs)))},
 finalInternalTimeErrorMs:{median:median(internal.map(x=>Math.abs(x.finalErrorMs))),max:Math.max(...internal.map(x=>Math.abs(x.finalErrorMs)))},
 oldVisibleEndErrorMs:{median:median(words.map(x=>Math.abs(x.oldVisibleEndErrorMs))),max:Math.max(...words.map(x=>Math.abs(x.oldVisibleEndErrorMs)))},
 finalVisibleEndErrorMs:{median:median(words.map(x=>Math.abs(x.finalVisibleEndErrorMs))),max:Math.max(...words.map(x=>Math.abs(x.finalVisibleEndErrorMs)))},
};
fs.writeFileSync(out+'/render-comparison.json',JSON.stringify({metrics,words,letters,inputs:{before:crypto.createHash('sha256').update(fs.readFileSync(out+'/render-before-all.json')).digest('hex'),after:crypto.createHash('sha256').update(fs.readFileSync(out+'/render-after-all.json')).digest('hex')}},null,2));
console.log(JSON.stringify(metrics,null,2));
console.log('Worst word rows:');for(const w of [...words].sort((a,b)=>b.oldMaxInternalErrorMs-a.oldMaxInternalErrorMs).slice(0,16))console.log(w.case,w.index,w.text,w.start,w.end,w.oldWorstLetter,w.oldWorstSignedErrorMs.toFixed(1),w.oldVisibleEndErrorMs.toFixed(1),w.finalMaxInternalErrorMs.toFixed(3));
