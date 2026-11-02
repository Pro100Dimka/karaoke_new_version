Karaoke artist verification: baseline v4 versus final

This directory contains evaluation tools only. The production algorithm is not
copied into the harness. origin-manifest.json records the previous audited tools
and their hashes. run_alignment.py is byte-identical to the previous runner;
other copied tools only change comparison labels from v3/v4 to baseline-v4/final.

Immutable baseline:
  /workspace/scratch/513dbcd967bf/baseline-v4-artists/karaoke_new_version-refactor-frontend-direct/python
Working final:
  /workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python
Python interpreter:
  /workspace/scratch/513dbcd967bf/runtime/venv/bin/python

Baseline source hashes are in ../baseline-v4-snapshot.json. The separate
../baseline-v4-support-snapshot.json adds unchanged fixtures read by cross-project
tests: launch scripts, installer code, AudioService source, Kaggle worker. The
original snapshot files were not changed. verification-map.json lists affected
test functions, commands and limitations.

MODEL WORK IS OWNED BY ROOT. These commands describe the evaluation sequence;
preparing this harness did not infer new ASR, MMS, VAD or pitch.

1. Freeze input audio and its SHA-256, exact audible transcript, language and
   duration before comparing predictions. The inference manifest must have
   timingHints: []. Optional instrumentalPath/instrumentalSha256 and
   recognitionPath/recognitionSha256 reuse existing stems/transcription. Never
   insert evaluation word labels into any inference input.

2. Run the unchanged baseline with run_alignment.py:
     --repo-python BASELINE --inputs INPUTS --case CASE --output RUNS/baseline-fresh/CASE
   It records model evidence once. A pre-populated AlignmentReuse directory or
   recognitionPath means model work was reused; the generic metadata mode string
   'fresh-existing-model-inference' must not be interpreted as proof that every
   model ran. Count actual stage events and describe reuse explicitly.

3. Replay that same evidence through the baseline and final:
     --repo-python BASELINE --inputs INPUTS --case CASE --output RUNS/baseline-replay/CASE --cache-from RUNS/baseline-fresh/CASE
     --repo-python FINAL --inputs INPUTS --case CASE --output RUNS/final-replay/CASE --cache-from RUNS/baseline-fresh/CASE
   Require baseline fresh/replay payload equality. A missing ASR context is a
   hard error, never a silent fresh call or empty substitute. Record all hashes.

4. compare_alignment.py --inputs INPUTS --before-dir RUNS/baseline-replay
     --after-dir RUNS/final-replay --output COMPARISON.json
   Include independent --reference and frozen --phone-map only if actually
   available. Without independent labels, onset/end error metrics are null.
   Every selected word remains in the report, including unchanged/bad neighbours.
   Traced elapsedSeconds include JSON/compressed-cache writes and are not a fair
   local speed benchmark, nor the duration of processing a full song.

5. After ROOT prepares actual existing-model CREPE cache, check_notes.py compare:
     --repo-python FINAL --inputs INPUTS --pitch-dir PITCH_CACHE
     --before-dir RUNS/baseline-replay --after-dir RUNS/final-replay
     --output-dir NOTES
   Files are NOTES/CASE/baseline-v4/lyricsSync.json and NOTES/CASE/final/lyricsSync.json.
   Both use exactly the same actual CREPE observations. Notes must be exact
   intersections of the common melody with saved words, codec must round-trip.
   No newly lost notes versus baseline does NOT establish correct ownership;
   notes_against_reference.py separately compares actual pitch points with
   external word labels when those labels exist. F0 remains model-estimated.

6. check_frontend.mjs --repo PROJECT --inputs INPUTS --documents-dir NOTES
     --output FRONTEND.json
   Before pitch is available, --payload-dir RUNS/final-replay explicitly uses
   empty notes instead. This executes actual editorApi letterFractions and
   karaokeLyrics progress/line selection, with uniform and nonuniform geometry.
   It is data-level verification, not real-font or Electron playback evidence.
   check_frontend_reference.mjs ties saved timing to independent word labels;
   never use model predictions or ASR times as their own accuracy ground truth.

7. Full affected backend gate (existing dependencies only):
     PYTHON run_backend_gate.py --repo-python FINAL --output NEW_OUTPUT
       --compare-result ../backend-baseline-v4-unconfined/result.json
   Use the same environment and authorized unconfined execution for BOTH runs:
   local Starlette TestClient reproducibly stalls in the network sandbox. The
   wrapper executes every check.bat backend constituent even when an earlier
   check fails, preserves every exit code and failure ID, and returns nonzero.
   It refuses failure-set comparison against an interrupted test run.
   The full final gate must run after the last relevant source/test edit.

No omitted tests, adjusted expectations, new model or dependency, audio changes,
UI changes, or production algorithm replacement are introduced by this harness.
