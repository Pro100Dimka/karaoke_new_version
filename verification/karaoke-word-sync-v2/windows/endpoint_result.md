# Sung-end endpoint correction

## Reproduced cause

`with_sung_ends` required the following frame timestamp to remain strictly before the next word's start, then saved the current frame timestamp. At a 10-ms hop this leaves a 10-ms gap for an exact frame boundary and a partial-hop gap for an off-grid boundary even when the activity mask is continuously true.

The activity mask is centered: `_levels` uses 20-ms windows centered at each 10-ms hop. The correction does not redefine these frames or change their thresholds. It allows an observed continuing frame to reach the already known next-word limit, with the existing clipping to that limit.

## Source and tests

- Source: `python/backend/ai_worker/ctc.py`, `with_sung_ends`: only `(frame + 1) * step < limit` → `frame * step < limit` was changed by this correction.
- New tests: `python/tests/test_sung_end_boundaries.py`.
- Existing test expected values were not edited.

## Evidence

| Case | Before | After |
| --- | ---: | ---: |
| Continuous activity, next word starts 2.000 s | preceding end 1.990 s | preceding end 2.000 s |
| Continuous activity, next word starts 2.005 s | preceding end 2.000 s | preceding end 2.005 s |
| Real 400-ms pause before the next word | preceding end 1.610 s | preceding end 1.610 s |
| Explicit silent frame immediately before 2.000 s | preceding end 1.990 s | preceding end 1.990 s |

The new full note-construction regressions verify that one sustained global note retains continuous word intersections at both seam locations, preserves absolute contour times, and has no missing target pitch/activity at 5-ms sampling through the seam.

Actual-old-function red: four failures / two passes (`endpoint_before.log`).

Post-fix targeted verification: 295 passes / one skip / one failure (`endpoint_targeted.log`). The sole failure is the existing CUDA-path embedding dtype expectation in `test_letter_alignment.py::test_speech_weights_are_cast_before_cuda_transfer_without_rounding_embeddings[cuda]`. Both `baseline-checks` and `pre-endpoint-checks` record the same node ID and reason. The targeted result is not an all-green full suite.

Ruff, format, and diff whitespace checks passed. Source/tests are frozen; the parent task owns final notebook/full-backend/real-audio verification.
