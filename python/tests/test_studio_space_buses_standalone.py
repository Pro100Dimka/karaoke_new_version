import sys,types,importlib.util,subprocess,threading,tempfile
from pathlib import Path
import numpy as np,soundfile as sf
for name in ['backend','backend.recordings','backend.recordings.studio_audio','backend.domain_errors']:
 m=types.ModuleType(name);m.__path__=[];sys.modules[name]=m
sys.modules['backend.recordings.studio_audio'].MasterRenderer=object
sys.modules['backend.recordings.studio_audio']._check_cancel=lambda e:None
class DependencyError(Exception):pass
sys.modules['backend.domain_errors'].DependencyError=DependencyError
p='/mnt/data/fx_work/karaoke_new_version-main/python/backend/recordings/studio_space.py'
spec=importlib.util.spec_from_file_location('backend.recordings.studio_space',p)
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
class Renderer:
 def _mix(self,a,b,graph,output,cancel):
  cmd=['ffmpeg','-nostdin','-y','-loglevel','error','-i',str(a),'-i',str(b),'-filter_complex',graph,'-map','[out]',*output]
  subprocess.run(cmd,check=True,timeout=25)
with tempfile.TemporaryDirectory() as d:
 d=Path(d);sr=16000;t=np.arange(sr*2)/sr
 audio=np.stack([0.09*np.sin(2*np.pi*220*t),0.09*np.sin(2*np.pi*220*t)],axis=1).astype('float32');audio[:sr//5]=0
 sf.write(d/'dry.wav',audio,sr,subtype='FLOAT')
 prof=m.SpaceProfile(delay_seconds=.11,delay_gain=.18,decay_seconds=.55,reverb_gain=.2,stereo_width=.5,effect_type='slapback')
 report=m._render_separate_buses(Renderer(),d/'dry.wav',d/'out.wav',threading.Event(),prof)
 output,_=sf.read(d/'out.wav',always_2d=True)
 print(report);print('frames',len(output),'dry rms',np.sqrt(np.mean(audio**2)),'out rms',np.sqrt(np.mean(output**2)))
 assert len(output)==len(audio) and np.isfinite(output).all() and np.max(abs(output-audio))>1e-5
