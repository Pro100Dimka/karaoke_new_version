import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {KaraokeLyrics} from '@neo-ui-kit/react';
import {useLyricFill} from 'karaoke-source/useLyricFill';
import {letterProgress} from 'karaoke-source/karaokeLyrics';
function Probe({c,index}) {
 const id='case-'+index;const words=React.useMemo(()=>c.line??[c.word],[c.line,c.word]);
 useLyricFill(id,words,c.time,'melodix');
 return React.createElement(KaraokeLyrics,{id,current:words.map(word=>({id:word.id,text:word.text,progress:letterProgress(word,c.time)})),next:[]});
}
const root=createRoot(document.getElementById('app'));
window.replayCases=async(cases)=>{
 flushSync(()=>root.render(React.createElement(React.Fragment,null,...cases.map((c,index)=>React.createElement(Probe,{c,index,key:index})))));
 await document.fonts.ready;
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 return true;
};
window.measuredProgress=letterProgress;

window.probeRenderCost=async(word)=>{
 const original=document.createRange;let measurements=0;
 document.createRange=function(){measurements++;return original.call(this)};
 const cases=[{word,time:word.start}];
 try {
  await window.replayCases(cases);const initial=measurements;
  const started=performance.now();
  for(let i=0;i<100;i++){cases[0].time=word.start+(word.end-word.start)*i/100;flushSync(()=>root.render(React.createElement(React.Fragment,null,React.createElement(Probe,{c:cases[0],index:0,key:0}))));}
  const elapsedMs=performance.now()-started;const afterUpdates=measurements;
  cases[0].time=word.start;flushSync(()=>root.render(React.createElement(React.Fragment,null,React.createElement(Probe,{c:cases[0],index:0,key:0}))));const afterSeek=measurements;
  const line=document.querySelector('.ad-lyrics-current');line.style.fontSize='80px';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const afterResize=measurements;
  flushSync(()=>root.render(null));const afterUnmount=measurements;
  document.fonts.dispatchEvent(new Event('loadingdone'));const afterUnmountFont=measurements;
  return {initial,afterUpdates,afterSeek,afterResize,afterUnmount,afterUnmountFont,updates:100,elapsedMs};
 }finally{document.createRange=original}
};
