import numpy as np
import soundfile as sf
from backend.recordings.studio_mix_audit import audit_mix


def test_stereo_phase_does_not_cancel(tmp_path):
    sr = 16000
    t = np.arange(sr) / sr
    signal = np.sin(2*np.pi*800*t).astype('float32') * .2
    voice = np.stack([signal, -signal], axis=1)
    backing = np.stack([signal*.2, signal*.2], axis=1)
    for name, data in [('v.wav', voice), ('b.wav', backing), ('m.wav', voice+backing)]:
        sf.write(tmp_path/name, data, sr, subtype='FLOAT')
    result = audit_mix(tmp_path/'v.wav', tmp_path/'b.wav', tmp_path/'m.wav')
    assert result['status'] == 'measured'
    assert result['voiceBandVocalToBackingMedianDb'] > 10
    assert result['outputVsStemSumResidualMedianDb'] < -70


def test_limiter_residual_is_detected(tmp_path):
    sr = 16000
    t = np.arange(sr) / sr
    voice = (.35*np.sin(2*np.pi*500*t)).astype('float32')
    backing = (.3*np.sin(2*np.pi*500*t)).astype('float32')
    for name, data in [('v.wav', voice), ('b.wav', backing), ('m.wav', np.clip(voice+backing, -.4, .4))]:
        sf.write(tmp_path/name, data, sr, subtype='FLOAT')
    result = audit_mix(tmp_path/'v.wav', tmp_path/'b.wav', tmp_path/'m.wav')
    assert result['outputVsStemSumResidualMedianDb'] > -40
