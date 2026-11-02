from __future__ import annotations
import hashlib,json,os,statistics,subprocess,time
from pathlib import Path

root=Path('/workspace/scratch/513dbcd967bf')
out=Path('/tmp/karaoke-sync-v3/performance')
python=root/'runtime/venv/bin/python'
versions={'v2':root/'baseline-v2/karaoke_new_version-refactor-frontend-direct/python',
          'final':root/'project/karaoke_new_version-refactor-frontend-direct/python'}
env=dict(os.environ,OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',NUMBA_CACHE_DIR='/tmp/karaoke-numba-cache')
executions=[]
for version,suffix in [('v2',''),('final',''),('final','-reverse'),('v2','-reverse')]:
    command=[str(python),str(out/'cached_pipeline_evidence.py'),str(versions[version]),str(out/f'{version}{suffix}.json'),
             '--fixtures',str(versions['final']/'tests/fixtures'),'--iterations','9']
    started=time.perf_counter()
    with (out/f'{version}{suffix}.log').open('w') as log:
        completed=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
    executions.append({'version':version,'suffix':suffix,'command':command,'exitCode':completed.returncode,'seconds':time.perf_counter()-started})
    (out/'executions.json').write_text(json.dumps(executions,indent=2))
    print(version,suffix,completed.returncode,flush=True)
    if completed.returncode:raise SystemExit(completed.returncode)
runs={version:[json.loads((out/f'{version}{suffix}.json').read_text()) for suffix in ('','-reverse')] for version in versions}
result={'scope':'CPU local forced alignment and postprocessing using existing CTC/ASR/singing masks; excludes model inference and decoding, not a full-song processing benchmark',
        'method':'One CPU thread; v2/final then final/v2;3warmups+9timedruns per case in each process; all18observations retained',
        'backendSourceHashesIdentical':runs['v2'][0]['sourceHashes']==runs['final'][0]['sourceHashes'],
        'cases':[]}
for i,name in enumerate(('fast','native_fast','reply')):
    row={'case':name,'durationSeconds':runs['final'][0]['cases'][i]['fragmentDurationSeconds'],'versions':{}}
    for version in versions:
        cases=[r['cases'][i] for r in runs[version]]
        samples=[v for c in cases for v in c['runtime']['runsMs']]
        row['versions'][version]={'medianMs':statistics.median(samples),'minMs':min(samples),'maxMs':max(samples),
            'allRunsMs':samples,'batchMediansMs':[c['runtime']['medianMs'] for c in cases],'calls':cases[0]['calls']}
        assert cases[0]['finalPayload']==cases[1]['finalPayload']
        assert all(all(c['assertions'].values()) for c in cases)
    a=runs['v2'][0]['cases'][i]; b=runs['final'][0]['cases'][i]
    row['sameInputs']=a['inputs']==b['inputs'];row['samePayload']=a['finalPayload']==b['finalPayload'];row['sameCalls']=a['calls']==b['calls']
    assert row['sameInputs'] and row['samePayload'] and row['sameCalls']
    row['medianDeltaPercent']=100*(row['versions']['final']['medianMs']/row['versions']['v2']['medianMs']-1)
    result['cases'].append(row)
(out/'comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps([{k:r[k] for k in ('case','durationSeconds','samePayload','sameCalls','medianDeltaPercent')} | {'v2Ms':r['versions']['v2']['medianMs'],'finalMs':r['versions']['final']['medianMs']} for r in result['cases']],indent=2))
