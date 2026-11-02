"""Read-only comparison of the current endpoint guard and a one-line candidate."""
import inspect
import json
from pathlib import Path

import numpy as np

from backend.ai_worker import ctc

source = inspect.getsource(ctc.with_sung_ends)
assert '(frame + 1) * step < limit' in source
namespace = dict(ctc.__dict__)
exec(source.replace('(frame + 1) * step < limit', 'frame * step < limit'), namespace)
proposed = namespace['with_sung_ends']
rate, hop = ctc._VOICE_RATE, ctc._VOICE_HOP
step = hop / rate
audio = np.sin(2*np.pi*220*np.arange(4*rate)/rate).astype(np.float32)
continuous = ctc.voiced_frames(audio, rate, hop)
silent_audio = audio.copy()
silent_audio[round(1.6*rate):round(2.0*rate)] = 0
silence = ctc.voiced_frames(silent_audio, rate, hop)
one_silent_frame = continuous.copy()
one_silent_frame[199] = False
cases = [
    ('continuous_exact_frame_boundary', continuous, audio, 2.0),
    ('continuous_between_frame_boundary', continuous, audio, 2.005),
    ('real_400ms_audio_pause_before_next_word', silence, silent_audio, 2.0),
    ('explicit_silent_frame_immediately_before_boundary', one_silent_frame, audio, 2.0),
]
result = {
    'proposed_source_change': '(frame + 1) * step < limit -> frame * step < limit',
    'step_seconds': step,
    'mask_length': len(continuous),
    'audio_duration_seconds': len(audio)/rate,
    'frame_interpretation': '_levels uses 2*hop samples centered at index*hop; no change to mask, thresholds, silence detection, or saved endpoint rounding.',
    'cases': [],
}
for name, activity, samples, limit in cases:
    words = [
        ctc.AlignedWord('я',1.0,1.2,(1.0,),.9),
        ctc.AlignedWord('один',limit,2.5,(limit,2.1,2.3,2.4),.9),
    ]
    old = ctc.with_sung_ends(words, samples, voiced=activity)
    new = proposed(words, samples, voiced=activity)
    result['cases'].append({
        'name':name, 'next_word_start':limit,
        'current_end':old[0].end, 'proposed_end':new[0].end,
        'current_gap':limit-old[0].end, 'proposed_gap':limit-new[0].end,
        'activity_1_95_to_2_02':activity[195:203].tolist(),
    })
    if 'continuous_' in name:
        assert new[0].end == limit
        assert old[0].end < limit
    else:
        assert old == new
        assert new[0].end < limit
    assert new[0].letters == old[0].letters
    assert new[1] == old[1]
root=Path('/tmp/karaoke-sync-v2/windows')
(root/'sung_end_endpoint_review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
