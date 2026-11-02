"""Read-only checks of completed preview files; no word timing ground truth."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.signal import correlate, correlation_lags


RATE = 8000


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args: list[str], *, timeout: int = 45) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, check=False, timeout=timeout)


def decoded_audio(path: Path, start: float = 0, duration: float | None = None) -> np.ndarray:
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-map', '0:a:0']
    if start:
        args += ['-ss', str(start)]
    if duration is not None:
        args += ['-t', str(duration)]
    args += ['-vn', '-ac', '1', '-ar', str(RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']
    result = command(args)
    if result.returncode or result.stderr:
        raise RuntimeError(f'Audio decode error: {path}: {result.stderr.decode(errors="replace")}')
    return np.frombuffer(result.stdout, dtype='<f4').astype(np.float64)


def correlation(reference: np.ndarray, decoded: np.ndarray) -> dict:
    size = min(len(reference), len(decoded))
    ref, out = reference[:size], decoded[:size]
    cc = correlate(out, ref, mode='full', method='fft')
    lags = correlation_lags(len(out), len(ref), mode='full')
    permitted = np.flatnonzero(np.abs(lags) <= RATE // 2)
    lag = int(lags[permitted[np.argmax(cc[permitted])]])
    if lag >= 0:
        matched_ref, matched_out = ref[:size - lag], out[lag:]
    else:
        matched_ref, matched_out = ref[-lag:], out[:size + lag]
    return {
        'comparedSamples': size,
        'lagSamples': lag,
        'lagMilliseconds': lag * 1000 / RATE,
        'zeroLagPearson': float(np.corrcoef(ref, out)[0, 1]),
        'alignedPearson': float(np.corrcoef(matched_ref, matched_out)[0, 1]),
        'referenceRms': float(np.sqrt(np.mean(ref * ref))),
        'decodedRms': float(np.sqrt(np.mean(out * out))),
    }


def verify(case: str, source: dict, root: Path) -> dict:
    marker = root / case / 'render-result.json'
    if not marker.is_file():
        return {'case': case, 'status': 'pending', 'reason': 'Completion marker absent; file not read.'}
    render = json.loads(marker.read_text())
    video, mix = Path(render['video']), Path(source['mixPath'])
    document = Path(render['document'])
    expected = render['clipEndSeconds'] - render['clipStartSeconds']
    video_hash_before = sha(video)
    probe = command(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(video)])
    if probe.returncode:
        raise RuntimeError(probe.stderr.decode(errors='replace'))
    metadata = json.loads(probe.stdout)
    streams = metadata['streams']
    audio_streams = [s for s in streams if s['codec_type'] == 'audio']
    video_streams = [s for s in streams if s['codec_type'] == 'video']
    if len(audio_streams) != 1 or len(video_streams) != 1:
        return {'case': case, 'status': 'failed', 'reason': 'Expected one video and one audio stream.', 'ffprobe': metadata}
    audio, picture = audio_streams[0], video_streams[0]
    full_decode = command(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-i', str(video), '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
    output_audio = decoded_audio(video)
    reference = decoded_audio(mix, render['clipStartSeconds'], expected)
    full_correlation = correlation(reference, output_audio)
    windows = []
    width = min(6.0, expected)
    for start in sorted({0.0, max(0.0, expected / 2 - width / 2), max(0.0, expected - width)}):
        first, last = round(start * RATE), round((start + width) * RATE)
        windows.append({'startSeconds': start, 'endSeconds': start + width, **correlation(reference[first:last], output_audio[first:last])})
    frame_step = 1 / render['fps']
    hashes = {
        'mixSha256': sha(mix),
        'lyricsSyncSha256': sha(document),
        'videoSha256Before': video_hash_before,
        'videoSha256After': sha(video),
    }
    checks = {
        'oneVideoOneAudioAndNoOtherStreams': len(streams) == 2,
        'videoH264': picture['codec_name'] == 'h264',
        'audioAac': audio['codec_name'] == 'aac',
        'streamStartsAtZero': all(abs(float(s.get('start_time', 'nan'))) <= 0.000001 for s in streams),
        'audioDurationWithin1ms': abs(float(audio['duration']) - expected) <= 0.001,
        'videoDurationWithinOneFrame': abs(float(picture['duration']) - expected) <= frame_step + 0.000001,
        'containerDurationWithinOneFrame': abs(float(metadata['format']['duration']) - expected) <= frame_step + 0.001,
        'reportedFrameCountMatchesRender': int(picture['nb_frames']) == render['frames'] == math.ceil(expected * render['fps'] - 1e-8),
        'completeAudioVideoDecodeWithoutErrors': full_decode.returncode == 0 and not full_decode.stderr,
        'audioGlobalLagWithin1ms': abs(full_correlation['lagMilliseconds']) <= 1,
        'audioLocalLagsWithin1ms': all(abs(w['lagMilliseconds']) <= 1 for w in windows),
        'audioGlobalCorrelationAbove0_99': full_correlation['alignedPearson'] > 0.99,
        'audioLocalCorrelationsAbove0_99': all(w['alignedPearson'] > 0.99 for w in windows),
        'mixMatchesFrozenInput': hashes['mixSha256'] == source['mixSha256'] == render['hashes']['audio'],
        'documentMatchesRenderInput': hashes['lyricsSyncSha256'] == render['hashes']['lyricsSync'],
        'videoUnchangedAndMatchesRender': hashes['videoSha256Before'] == hashes['videoSha256After'] == render['videoSha256'],
    }
    return {
        'case': case,
        'status': 'passed' if all(checks.values()) else 'failed',
        'video': str(video),
        'mix': str(mix),
        'document': str(document),
        'expectedDurationSeconds': expected,
        'checks': checks,
        'hashes': hashes,
        'ffprobe': metadata,
        'fullDecode': {'exitCode': full_decode.returncode, 'stderr': full_decode.stderr.decode(errors='replace')},
        'audioComparison': {
            'analysisRateHz': RATE,
            'lagResolutionMilliseconds': 1000 / RATE,
            'maxSearchedAbsoluteLagMilliseconds': 500,
            'positiveLagMeans': 'MP4 decoded sound is later than reference mix',
            'decodedSamples': len(output_audio),
            'referenceSamples': len(reference),
            'decodedPcmDurationSeconds': len(output_audio) / RATE,
            'note': 'AAC decoded buffer can include final codec block padding; container and track durations are checked separately. Correlation uses the requested source interval. Downmix/resampling is analysis only.',
            'wholeClip': full_correlation,
            'localWindows': windows,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', action='append')
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--render-root', type=Path, required=True)
    args = parser.parse_args()
    sources = {c['case']: c for c in json.loads(args.inputs.read_text())['cases']}
    assert not args.case or set(args.case) <= sources.keys()
    target = args.render_root / 'video-verification.json'
    previous = json.loads(target.read_text()) if target.exists() else {}
    results = {r['case']: r for r in previous.get('results', [])}
    for case in args.case or sources:
        try:
            result = verify(case, sources[case], args.render_root)
        except Exception as exc:
            result = {'case': case, 'status': 'failed', 'error': f'{type(exc).__name__}: {exc}'}
        results[case] = result
        print(json.dumps({'case': case, 'status': result['status'], 'failedChecks': [k for k,v in result.get('checks', {}).items() if not v], 'error': result.get('error')}, ensure_ascii=False), flush=True)
    report = {
        'verifiedUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Independent read-only technical verification of rendered MP4s, source hashes, complete decode, and decoded audio timing.',
        'limitations': ['No listening performed.', 'Does not establish word/letter acoustic ground truth.', 'Does not validate visual glyph drawing or frontend sampling logic.', 'This is a programmatic preview, not an Electron playback recording.'],
        'results': [results[c] for c in sources if c in results],
    }
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    if any(result['status'] == 'failed' for result in report['results']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
