from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, '/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python')
from backend.ai_worker import speech
from backend.ai_worker.ctc import AlignedWord
from backend.lyrics.domain import Word

rng = random.Random(41737)
kept = fallback = changed = 0
for _ in range(800):
    count = rng.randrange(3, 9)
    raw = [.2, 1.16]
    for i in range(2, count):
        raw.append(round(raw[-1] + rng.uniform(.005, .25), 3))
    end = raw[-1] + .2
    before = AlignedWord('а' * count, .2, end, tuple(raw), .7)
    started = replace(before, start=.06, letters=tuple(round(x - .14, 3) for x in raw))
    replacement = list(raw)
    replacement[0] = 1.02
    index = rng.randrange(1, count)
    low = replacement[index - 1] + .001
    high = replacement[index + 1] - .001 if index + 1 < count else end - .001
    replacement[index] = round(rng.uniform(low, high), 3)
    core = replace(before, start=1.02, letters=tuple(replacement), diagnostics=('OnsetRecovered',))
    adjusted = replace(core, start=1.0, letters=tuple(round(x - .02, 3) for x in replacement))
    result = speech._preserved_onset_letters(before, core, started, adjusted)
    Word(result.text, result.start, result.end, (), result.letters).validate()
    assert (result.start, result.end, result.score) == (adjusted.start, adjusted.end, adjusted.score)
    for i in range(count):
        if before.letters[i] != core.letters[i]:
            assert result.letters[i] == adjusted.letters[i]
    if result.letters != adjusted.letters:
        changed += 1
        assert 'ApproximateLetterTiming' in result.diagnostics
        assert 'LetterTimingReviewRequired' in result.diagnostics
    elif result.diagnostics != adjusted.diagnostics:
        fallback += 1
    else:
        kept += 1
    ordinary = replace(core, diagnostics=())
    assert speech._preserved_onset_letters(before, ordinary, started, adjusted) is adjusted
    changed_end = replace(core, end=end + .01)
    assert speech._preserved_onset_letters(before, changed_end, started, adjusted) is adjusted

report = {'sourceSha256': hashlib.sha256(Path(speech.__file__).read_bytes()).hexdigest(),
          'seed': 41737, 'cases': 800, 'mixedRestorations': changed,
          'completeCandidateFallbacks': fallback, 'unchangedCandidates': kept,
          'validated': ['word bounds and score unchanged', 'all letters within word and nondecreasing',
                        'independently changed raw anchors retained',
                        'ordinary reviews and changed-end reviews untouched',
                        'mixed restorations explicitly approximate'],
          'scope': 'Synthetic helper-contract probe; no ASR/MMS/VAD/pitch model inference or acoustic accuracy claim.'}
target = Path('/tmp/karaoke-sync-v4/review/onset-anchor-independent-probe.json')
target.write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
