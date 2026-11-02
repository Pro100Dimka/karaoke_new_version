"""Compare current planner and an isolated cursor prototype; production is unchanged."""
from bisect import bisect_left
import inspect
import json
from pathlib import Path
import statistics
import time

from backend.ai_worker import ctc, word_guidance

namespace = dict(word_guidance.__dict__)
namespace['bisect_left'] = bisect_left
planner = inspect.getsource(word_guidance._review_windows)
planner = planner.replace(
    '    for first, last in ranges:\n        while remaining := [index for index in targets if first <= index < last]:\n            target = remaining[0]',
    '    cursor = 0\n    for first, last in ranges:\n        last_target = targets[bisect_left(targets, last) - 1]\n        while cursor < len(targets) and targets[cursor] < last:\n            target = targets[cursor]',
)
planner = planner.replace('first, last, target, margin, total, voiced, onsets', 'first, last, target, margin, total, voiced, onsets, last_target')
planner = planner.replace('            first = stop\n', '            first = stop\n            cursor = bisect_left(targets, stop, cursor + 1)\n')
stop = inspect.getsource(word_guidance._review_stop)
stop = stop.replace('    onsets: Sequence[float],\n', '    onsets: Sequence[float],\n    last_target: int,\n')
stop = stop.replace('any(stop <= index < last for index in reviewed)', 'last_target >= stop')
exec(stop + '\n\n' + planner, namespace)
prototype = namespace['_review_windows']

report = {'scope': 'Planner only, no CTC/models, no activity scans; exact window equality required.', 'results': []}
for count in (100, 1000, 10000):
    words = [ctc.AlignedWord('дом', i*.8, i*.8+.4, (), .1) for i in range(count)]
    for label, reviewed in [('every_third', frozenset(range(0,count,3))), ('dense', frozenset(range(count)))]:
        samples = {'current': [], 'cursor': []}
        expected = word_guidance._review_windows(words, {}, reviewed, .6, count*.8)
        assert prototype(words, {}, reviewed, .6, count*.8) == expected
        for _ in range(3):
            for name, function in [('current', word_guidance._review_windows), ('cursor', prototype)]:
                begin = time.perf_counter()
                function(words, {}, reviewed, .6, count*.8)
                samples[name].append((time.perf_counter()-begin)*1000)
        entry={'word_count':count,'flags':len(reviewed),'pattern':label,'windows':len(expected),'samples_ms':samples,'median_ms':{name:statistics.median(values) for name,values in samples.items()}}
        report['results'].append(entry)
        print(json.dumps(entry), flush=True)
Path('/tmp/karaoke-sync-v2/windows/benchmark_target_scan.json').write_text(json.dumps(report,indent=2)+'\n')
Path('/tmp/karaoke-sync-v2/windows/cursor_prototype.py').write_text(stop+'\n\n'+planner)
