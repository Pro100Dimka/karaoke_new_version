from __future__ import annotations
import hashlib,json,os,subprocess,time
from pathlib import Path

repo=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/frontend')
out=Path('/tmp/karaoke-sync-v3/frontend-checks');out.mkdir(parents=True,exist_ok=True)
def hashes():
    roots=[repo/'src',repo/'electron',repo/'scripts']
    files=[p for root in roots for p in root.rglob('*') if p.is_file()]
    files.extend(repo/p for p in ('package.json','package-lock.json','tsconfig.app.json','electron/tsconfig.json','vitest.config.ts') if (repo/p).is_file())
    return {str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
summary={'sourceHashesBefore':hashes(),'checks':{}}
for label,command in [('typecheck',['npm','run','typecheck']),('npm-test',['npm','test']),
                      ('node-tests',['node','--test','electron/*.test.mjs','scripts/*.test.mjs'])]:
    started=time.perf_counter()
    with (out/f'{label}.log').open('w') as log:
        result=subprocess.run(command,cwd=repo,env=dict(os.environ,CI='true'),stdout=log,stderr=subprocess.STDOUT)
    summary['checks'][label]={'command':command,'exitCode':result.returncode,'seconds':time.perf_counter()-started}
    (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(label,result.returncode,flush=True)
summary['sourceHashesAfter']=hashes()
summary['sourceUnchanged']=summary['sourceHashesBefore']==summary['sourceHashesAfter']
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'checks':summary['checks'],'sourceUnchanged':summary['sourceUnchanged'],'sourceFileCount':len(summary['sourceHashesAfter'])},indent=2))
raise SystemExit(0 if summary['sourceUnchanged'] and all(c['exitCode']==0 for c in summary['checks'].values()) else 1)
