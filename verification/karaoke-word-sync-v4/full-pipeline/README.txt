Reproduction scripts and scope
==============================

Read outcome.txt / outcome.json first. The recorded full v3 run FAILED at the
existing 1,800-second CREPE worker timeout. There is no successful full-song
lyricsSync or complete cached-orchestrator benchmark in this result.

The provided scripts are verification instrumentation outside the application.
They were executed on Linux CPU and use Python's POSIX resource module for RSS.
Use the project's existing Python environment and its already available catalog
models (htdemucs, Whisper turbo, MMS, and installed CREPE full). No new model or
dependency is introduced. Supply local paths for the capitalized placeholders:

  OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 python run_full_pipeline.py \
    --repo-python REPO_PYTHON --models MODEL_STORE --source SOURCE_AUDIO \
    --output NEW_RUN_OUTPUT --numba-cache SHARED_NUMBA_CACHE \
    --title Километры --artist Wildways --language Russian

NEW_RUN_OUTPUT must have no existing profile. The real PipelineOrchestrator
runs in that isolated profile; cleanup retains generated analysis files. The
scope includes normalization, music analysis, separation, vocal validation,
ASR, alignment, pitch/stabilization, notes, melody generation, validation and
publication. Source download, import/admission, interpreter startup and model
download are excluded from a successful fullBackendWallSeconds field. On a
failure, inspect the error and progress events instead of inventing that field.

The model store path and Numba cache path are parameters in this delivered
version. The original runner's hash and the parameterization difference are
documented in outcome.json. The measured run used a shared existing Numba cache,
not an explicitly capped NUMBA_NUM_THREADS. Its observed thread-cap escape and
background workloads must be kept in mind when interpreting timing data.

Optional --setup-only checks production wiring without running AI inference.
Optional --cache-from COMPLETED_BASELINE_OUTPUT enables exact, hash-checked
model-result replay. This requires a successfully completed source run with
actual ASR, MMS and pitch outputs. The recorded failed run does not qualify.
It is a verification adapter, not a new production caching feature. Both
versions must use the same cache mode for a fair algorithm comparison.

cached_results.py checks source/stem hashes and replays completed model payloads.
replay_worker.py executes the real alignment/refinement code using recorded
ASR/MMS evidence and blocks fresh model loads. Missing ASR contexts fail visibly
even if the production caller catches the inference exception. trace_worker.py
records input/output stages and deterministic seeds without replacing models.

Runtime outputs can contain private source audio, complete ASR lyrics and model
evidence. Keep those local; they are deliberately not included in this delivered
verification folder. The source music, model weights, and full lyrics are not
redistributed. Numerical metrics/hashes and code are supplied here only.
