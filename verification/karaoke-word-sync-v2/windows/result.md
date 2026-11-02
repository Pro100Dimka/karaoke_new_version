# Bounded local review windows — implementation evidence

## Changes

Only `python/backend/ai_worker/word_guidance.py` within the assigned planner/review block and new `python/tests/test_review_windows.py` were edited by this task.

- Ordinary CTC review crops have both a 12-word and 8-second limit.
- Merely touching neighbor ranges no longer merge. Truly overlapping ranges split at a real silent gap, independently corroborated boundary/onset, or stable context when available.
- Adjacent conflicting words near a numerical limit stay in one window by choosing an earlier reliable cut.
- Each reviewed word has one window assignment. Adjacent crops share a boundary, so the same audio is not decoded repeatedly.
- Complete adjacent original context groups are packed under both caps. Deliberately chosen acoustic split points, sparse word gaps, and instrumental audio gaps are retained.
- Sorted targets advance through a cursor/binary search. Neither planning loop rescans all review flags for every local window.
- A single indivisible long word retains its complete crop rather than being clipped to the time limit.
- The acceptance check also respects outside words. An unavoidable unsafe cut cannot erase a cross-window conflict by shortening its body.
- If many literally coincident cores leave an empty crop, the targets remain represented in the plan, no unsupported repair is accepted, and ordinary ordering/review/export retains `BoundaryConflict` plus `TimingReviewRequired`.
- Recognition padding cannot override stable neighboring CTC anchors and create a distant overlap.

## Exact motivating case

100 words / 33 flagged positions (every third word):

| Metric | Original | Revised |
| --- | ---: | ---: |
| Review calls | 1 | 11 |
| Largest word count | 98 | 9 |
| Largest audio crop | 78.4 s | 7.4 s |
| Flag assignments | 33 | 33 |
| Duplicated audio | 0 s | 0 s |

These are final-source call dimensions. The initial uncoalesced version used 33 calls; follow-up profiling identified that fixed call overhead and led to bounded packing. Full-pipeline runtime measurement remains with the root task.

### Read-only cached CTC microbenchmark

Two warmup rounds, nine shuffled measured rounds, CPU, one Torch thread with OMP/MKL/OpenBLAS set to one. Existing synthetic emissions were reused; real torchaudio forced alignment and word reconstruction ran in every measured case. No ASR or emission model ran.

| Pattern | Baseline median | Initial 33-call-cap planner median | Packing prototype median |
| --- | ---: | ---: | ---: |
| 100 words / 33 flags | 25.66 ms / 1 call | 33.02 ms / 33 calls | 24.04 ms / 11 calls |
| 100 words / 100 flags | 29.38 ms / 1 call | 29.16 ms / 11 calls | 31.96 ms / 11 calls |
| 100 words / 10 sparse flags | 9.88 ms / 10 calls | 10.26 ms / 10 calls | 10.04 ms / 10 calls |

These are synthetic microbenchmarks, not real-song or final-pipeline speedup claims. Every variant recovered the synthetic boundaries with maximum error below 1.5e-14 s. The earlier nine-thread run was noisier and is preserved separately.

The cursor prototype produced exactly equal window objects at 100, 1,000, and 10,000 words. At 1,000 words planner-only medians fell from about 14 ms to 7 ms; at 10,000 from about 900 ms to 56–94 ms. Sub-millisecond measurements at 100 words were noisy, so no small-song cursor speedup is claimed.

## Verification

- Actual test-first run: 11 failures / 2 passes before implementation (`pytest_before.log`).
- Final focused run: 47 passes (`pytest_final.log`), covering 27 new window cases plus the current 20 timing-review cases.
- RU/UK regressions use actual torchaudio forced alignment on synthetic emissions and recover both words across the nominal split boundary. No model weights or new model calls are involved.
- Ruff check and format check: pass.
- Focused mypy with the project configuration: pass (`mypy.log`).
- `git diff --check`: pass.
- Architecture comparison: no new function violations; every new/modified planner function is at most 40 physical lines. Existing file-length violation and existing `with_word_guidance` / `_matching_blocks` size violations remain unchanged in category.

## Files

- `before_chain.json`, `after_chain.json`: exact case details.
- `word_guidance.before.py`: immutable source snapshot before this task.
- `budget_before.log`: first exact-function budget failure before dependencies were restored.
- `pytest_before.log`: proper imported pytest red run in the restored environment.
- `padded_overlap_before.log`: reproduced padding overlap before the guard was corrected.
- `coalescing_before.log`: regression first failed with 33 calls instead of the expected 11.
- `benchmark_cached_ctc.json`, `benchmark_cached_ctc_threads1.json`: raw cached-emission timing samples and counts.
- `benchmark_target_scan.json`: planner scaling and exact-equality evidence for cursor/bisect.
- `pytest_final.log`, `mypy.log`, `architecture.log`: final/affected verification logs.

Root owns full-backend verification, real-recording measurement and live application gate reporting. This evidence alone does not establish real-song timing accuracy or live karaoke behavior.

## Independent follow-up review

No blocking regression was found in the root's per-align feature reuse/no-op path or the Odin helper during read-only inspection. Audible mask rate/hop remain identical, shared arrays are not mutated, and the cache cannot leak across songs. The adjacent atomic-pair constraint retains both alternatives in the selector; the intentionally uncertain onset remains explicitly marked.

A separate read-only review confirmed an existing `with_sung_ends` endpoint off-by-one: continuous voice ends one hop before an exactly aligned following boundary (or a partial hop before a fractional boundary). `sung_end_endpoint_review.json` records the pre-fix function against an isolated one-line predicate prototype and verifies real-pause counterexamples.

After the root's explicit GO and completion of its prior full gate, this task added `python/tests/test_sung_end_boundaries.py`, reproduced four failing continuous-word/note cases with two passing silence controls, then changed exactly one endpoint predicate in `python/backend/ai_worker/ctc.py`: `(frame + 1) * step < limit` became `frame * step < limit`. The existing `continued[frame]` requirement and `min(..., limit)` clipping remain authoritative; no silent gap is filled unconditionally.

The post-fix targeted run covered ten suites: 295 passed, one skipped, one failed. The failure is `test_speech_weights_are_cast_before_cuda_transfer_without_rounding_embeddings[cuda]`, with the same embedding dtype failure already recorded in both baseline and pre-endpoint full checks. All six new endpoint tests pass, including exact and fractional seams, real/explicit silent frames, global-note intersections, absolute contour timestamps, and continuous 5-ms target frames. Existing expected values were not edited. Ruff, formatting, and diff whitespace checks pass.

Endpoint evidence: `endpoint_before.log`, `endpoint_targeted.log`, `sung_end_endpoint_review.json`, and `review_sung_end_endpoint.py`. All source and test files are frozen. The root owns the rebuilt notebook, the final full gate, and final whole-alignment performance measurements; the earlier 100-word microbenchmark is explicitly a prototype comparison and must not be presented as a final-artifact timing.
