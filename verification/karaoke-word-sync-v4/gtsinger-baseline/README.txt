Fresh v3 alignment of independent GTSinger recordings

Six sequential processes, 34 words total. The primary cohort contains four
preselected clips / 24 words. Two independently selected later clips form an
additional held-out cohort / 10 words; they are not replacements for poor results.

Inference reads inference-inputs.json or additional-inference-inputs.json, which
contain only audio paths, audio checksums, transcripts, language and duration.
The word/phoneme reference intervals are not present in these manifests, are not
passed as timing hints, and are not made available to speech.align. Every call
uses language Russian and the exact existing MMS_FA / Whisper large-v3-turbo
models from the production catalog. Model checksum evidence is in metadata.json.

Each case directory includes:
  metadata.json: code/audio hashes, model identity, wall time, peak memory.
  payload.json: final production alignment including diagnostics and letters.
  stages.json: traced input/output words at intermediate production functions.
  acoustic-cache.npz: decoded 16kHz waveform, CTC scores and frame_seconds,
    singing_frames, voiced_frames and vocal_onsets, on the original clip timeline.
  alignment-evidence.json: independent ASR timings and views.
  asr-cache.json: complete actual ASR requests and results, including local contexts.
  model-reuse/: existing production encoder/context reuse files.

All times are local to the supplied clip (offset 0). Original WAV is 48kHz;
the untouched production reader resamples to16kHz. CTC step20ms; activity step10ms.
No source audio is rewritten or time-shifted. Production backend files remained
unchanged during all six runs.

Wall times are isolated speech.align calls, including file decode, loading the
existing models, fresh inference and local word refinement. They exclude imports,
separation, pitch inference and complete song processing. Wrapper tracing and
cache writes add a little overhead. This is CPU inference with two threads, not
a measurement on the user's RTX3060. Per-process elapsed times are also saved.

Baseline cached replay was validated for all six cases: every final payload is
exactly equal to its fresh-model baseline payload. See replay-validation.json.
The replay path forbids missing ASR contexts: a changed request fails comparison
rather than silently substituting another result. No v4 run is included here.

Example command for a later v4 replay, after source is finalized:

AD_VOICE_MODELS=/workspace/scratch/513dbcd967bf/runtime/models-v4 AD_VOICE_COMPUTE_DEVICE=cpu OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 NUMBA_CACHE_DIR=/tmp/karaoke-numba-cache /workspace/scratch/513dbcd967bf/runtime/venv/bin/python /tmp/karaoke-sync-v4/gtsinger-baseline/run_alignment.py --repo-python /workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python --inputs /tmp/karaoke-sync-v4/gtsinger-baseline/inference-inputs.json --case control_0000 --output /tmp/karaoke-sync-v4/gtsinger-final/control_0000 --cache-from /tmp/karaoke-sync-v4/gtsinger-baseline/control_0000

Use additional-inference-inputs.json for control_0003/control_0004.
For a fresh repeat omit --cache-from and choose a new output directory so the
production model reuse folder is initially empty. Exact historical script bytes
are retained under script-versions/ to match each recorded scriptSha256.

Metrics compare final predictions with the frozen external published reference.
Those labels were prepared by the dataset authors with alignment plus manual
correction; they are not our own listening annotations. Their per-boundary error
is unknown and some phone labels show uniform subdivision or suspicious long
approximants. Such phone labels were flagged in the reference and must not be
treated as independent precise phone truth. Word metrics retain every selected
word, including large errors. Primary and additional cohorts remain separate.

Licensing: recordings and reference data are from GTSinger under CC BY-NC-SA4.0
plus the author's saved additional terms. The caches contain resampled dataset
audio. Do not put these audio/cache/model-reuse files in the application release.
Use source download manifests, checksums, scripts and numerical reports for a
reproducible verification handoff; preserve source/license attribution.
