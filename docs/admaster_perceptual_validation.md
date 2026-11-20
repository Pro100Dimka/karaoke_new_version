# Offline perceptual validation for AD Master

`python/scripts/audit_audio_quality.py` is an opt-in developer audit. It reads
previously frozen comparison windows and produces all four Audiobox Aesthetics
predictions: Content Enjoyment (`CE`), Content Usefulness (`CU`), Production
Complexity (`PC`), and Production Quality (`PQ`). These are learned model outputs,
not listening scores out of ten, and a high number does not certify studio sound.

The command is independent of the production renderer. It never creates a new
master, searches processing parameters, chooses better-scoring windows, installs
packages, downloads weights, or uploads audio. No weights or test recordings are
included in the repository.

## Pinned official artifacts

Use an existing local checkout/snapshot and model directory. The loader verifies
the bytes before importing the optional ML packages, instantiates
`AesMultiOutput` directly, loads `model.safetensors` with `strict=True`, and runs
on CPU with batch size one. It does not call `from_pretrained` or the upstream
checkpoint-download helper. Hugging Face offline mode and telemetry opt-out are
set before the optional imports.

| Artifact | Frozen identity |
| --- | --- |
| Official source | [`facebookresearch/audiobox-aesthetics`, revision `2618e9d451b456e9328b39495b5e6234678aa550`](https://github.com/facebookresearch/audiobox-aesthetics/tree/2618e9d451b456e9328b39495b5e6234678aa550) |
| Official model | [`facebook/audiobox-aesthetics`, revision `9b1dd8e5df9af7216e836a98974fe3b82c56ded6`](https://huggingface.co/facebook/audiobox-aesthetics/tree/9b1dd8e5df9af7216e836a98974fe3b82c56ded6) |
| Weights | [`model.safetensors`](https://huggingface.co/facebook/audiobox-aesthetics/resolve/9b1dd8e5df9af7216e836a98974fe3b82c56ded6/model.safetensors), 415,472,992 bytes; SHA-256 `a5a3c2412649cc2384ec525ffd5180ce6c4778f43bed6108e0a1303de04d014e` |
| Configuration | [`config.json`](https://huggingface.co/facebook/audiobox-aesthetics/resolve/9b1dd8e5df9af7216e836a98974fe3b82c56ded6/config.json); SHA-256 `0b8eabc5ced92cefed116a3aca8f1e59d2a33dc4d376b9e86dfb9c072e1d280d` |

All eight Python files in the upstream package have pinned SHA-256 values in
`scripts/audio_quality/model.py`. A mismatching or additional Python file is
rejected. The upstream [license](https://github.com/facebookresearch/audiobox-aesthetics/blob/2618e9d451b456e9328b39495b5e6234678aa550/LICENSE)
is CC BY 4.0 for the majority of the project; the pinned
[README license notice](https://github.com/facebookresearch/audiobox-aesthetics/blob/2618e9d451b456e9328b39495b5e6234678aa550/README.md#license)
identifies WavLM portions under MIT. Preserve upstream attribution and notices
when preparing or sharing an analysis environment.

Optional audit runtime packages are `torch`, compatible `torchaudio`,
`safetensors`, and `huggingface_hub`, alongside the project's existing `numpy`
and `soundfile`. The validated local environment used Torch/Torchaudio 2.11.0.
The CLI does not install these packages, and normal application checks do not
require this model or its weights. `--help` and input-contract tests do not load
the optional ML runtime.

## Frozen comparison contract

The accepted schema is the fixed-window comparison manifest, not a directory
scan or a list of arbitrarily selected tracks:

- `count`, `sourceCount`, `sampleRate`, `channels`, `commonTargetLufs`,
  `mappingSha256`, `sourceSha256`, and `files` describe the frozen cohort.
- Each entry has a unique blind `id`, `sourceId`, `recordingId`, `windowId`,
  integer `startFrame` and `frameCount`, and one positive scalar `linearGain`
  consistent with `gainDb`. A window must fit the source and last at most ten
  seconds. If present, `endFrameExclusive` must agree exactly.
- The separate mapping's `sourceConditions` resolves source IDs to paths,
  SHA-256 values, total frames, sample rate and channels. Condition labels and
  other descriptive fields are discarded before prediction.

The caller supplies the previously recorded `--manifest-sha256`; calculating a
new hash after changing a cohort is not validation of the original experiment.
The CLI verifies that hash, the mapping hash, both declarations of each source
hash, actual source headers, crop boundaries, and finite PCM. It applies exactly
the declared scalar to both channels. It does not adjust gain according to any
prediction, truncate an invalid crop, repair a sample, or realign the singer.

All windows receive an input preflight before model construction. A normalized
sample peak above −1.3 dBFS is rejected. LUFS and true-peak *metering* remain the
responsibility of the frozen preparation step; the audit does not claim to
remeasure them. Their reported target must be no louder than −18 LUFS. Source,
manifest, mapping, model and configuration hashes are checked again before the
result is published. Invalid input causes a nonzero exit code even with
`python -O`; an existing output file is never overwritten.

The waveform adapter follows the pinned upstream single-window path: resample
to 16 kHz, average channels to mono, pad shorter windows to 160,000 samples,
mark only actual samples valid, and undo the configured target mean/std for
each axis. There is no additional normalization or processing in this adapter.

## Reproduce the existing 120-window comparison

Run from the repository root using the existing analysis environment. These
paths describe the current local snapshot, not required installation paths:

```bash
AUDIT_DATA=/workspace/scratch/ac7d07ecd4ad/checks/perceptual-evaluation
AUDIT_PYTHON=/workspace/scratch/3fab33f62f10/karaoke_new_version/.venv/bin/python
ORT_DISABLE_TELEMETRY=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2 NUMBA_NUM_THREADS=2 \
  "$AUDIT_PYTHON" python/scripts/audit_audio_quality.py \
  --source-dir "$AUDIT_DATA/audiobox-source" \
  --model-dir "$AUDIT_DATA/audiobox-model" \
  --manifest "$AUDIT_DATA/comparison-manifest.json" \
  --manifest-sha256 63fac143acf9fa09e8b347263974e9217174ad8afebe70463d4c550ab8573800 \
  --mapping "$AUDIT_DATA/comparison-mapping-sealed.json" \
  --output "$AUDIT_DATA/comparison-cli-scores.json" \
  --threads 2
```

This cohort contains the original timeline, current production master and
previous master for native takes 6, 9 and 10. Each take uses a fixed 10-second
grid plus a final ten-second window ending at the last frame: respectively
13, 12 and 15 windows per condition. The last windows overlap their predecessor
by 5.483, 9.220 and 6.327 seconds; they are not independent extra observations.
All 120 windows were prepared at −18.0 LUFS by static gain alone; the largest
measured true peak was −3.2 dBTP. The manifest and separate mapping preserve the
exact sample offsets, source SHA-256 and filesystem modification dates.

A later candidate must use the same windows and target, in a new frozen
manifest with its own recorded hash. Do not overwrite or silently expand the
existing experiment. An added candidate that cannot meet the frozen headroom
must be reported explicitly instead of changing the comparison's target.

## Prior sanity experiment and limits

The local sanity set was frozen before inference: six ten-second anchors
(three public wet vocals and three native premaster sums), with baseline,
shared-threshold P90 hard clipping, Gaussian noise at 0 dB SNR, and a diffuse
1.5-second reverb tail whose wet energy equalled dry energy. The native anchors
also had missing-vocal and +120 ms vocal-delay variants. All 30 files were
statically normalized to −18.0 LUFS; conditions and hashes were stored
separately from the blinded model input.

The predeclared qualification used `PQ`: noise had to lower all six paired
scores with median drop at least 0.5; clipping had to lower at least five of
six with median drop at least 0.1. The fixed result was:

| Control | Paired direction | Median PQ decrease |
| --- | --- | ---: |
| 0 dB SNR noise | 6/6 lower | 3.1294 |
| P90 hard clipping | 6/6 lower | 0.3733 |
| Excessive reverb | 6/6 lower | Diagnostic direction; not a qualification threshold |

The batch took 28.48 seconds locally, with median inference time 0.889 seconds
per ten-second clip. This supports using the pinned model as an independent
paired technical-quality signal in this environment. It does not establish
general validity for every recording or authorize optimizing the renderer
against the model. The original sanity policy and results remain in the local
`checks/perceptual-evaluation/criteria.json` and `sanity-results.json`; audio and
model files are deliberately not committed.

In particular, the model did not reliably flag the delayed vocal in take 9 or
the missing vocal in take 10. Its mono 16 kHz representation also cannot certify
stereo width, phase behavior or high-frequency detail. Keep independent checks
for voice presence, timing, pitch, masking, clipping and stereo compatibility,
and use controlled listening for artistic decisions. A prediction is never
evidence that the assistant listened: every output records
`auditionedByAssistant: false` and explicit limitations.

## Focused developer verification

From `python/`, run `python -m pytest -q tests/test_audio_quality_audit.py`.
The tests use small generated PCM and an injected fake predictor. They cover
hash changes, exact format/crops, invalid or changing gain, nonfinite audio,
duplicate IDs, model-output integrity, mutation during scoring, optimized
Python validation, and lazy optional imports. They neither download nor score
with the real weights. A real offline CLI run on a separately frozen candidate
is the end-to-end model/runtime check.
