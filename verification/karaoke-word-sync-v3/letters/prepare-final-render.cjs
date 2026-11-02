const fs=require('node:fs');
const repo=process.env.REPO_ROOT||'/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct';
const out=process.env.EVIDENCE_DIR||__dirname;
require(repo+'/frontend/node_modules/esbuild').buildSync({entryPoints:[out+'/render-final-entry.js'],outfile:out+'/render-final.js',bundle:true,nodePaths:[repo+'/frontend/node_modules'],alias:{'karaoke-source':repo+'/frontend/src/features/karaoke'},platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}});
fs.writeFileSync(out+'/render-final.html','<!DOCTYPE html><meta charset="utf-8"><style>'+fs.readFileSync(out+'/renderer-style.css','utf8')+'</style><div id="app"></div><script src="render-final.js"></script>');
