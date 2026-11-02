# Local review windows: evidence and contract

## Baseline

- Snapshot: `word_guidance.before.py`.
- Exact current `_review_windows` reproduction: `before_chain.json`.
- 100 words at 0.8 s spacing, each 0.4 s long, 33 reviewed positions (0, 3, ..., 96).
- Current result: one `[0, 98)` alignment, 98 words and 78.4 s. The union condition treats touching context intervals as overlap and merges transitively without either limit.
- The first reproduction executes the unchanged function AST and its actual dataclasses because the supplied Python venv has not yet been created. Full imported tests are still required.

## Proposed constraints

1. Reuse the existing emission, activity mask, independent word spans and onset evidence. No extra recognition/model work.
2. Limit each ordinary alignment to both 12 words and 8 s. A single indivisible sung word may exceed 8 s; do not clip a sustained word solely to satisfy a work budget.
3. Do not merge merely touching immediate-neighbor context ranges. Bound any actual overlapping chain.
4. Prefer acoustic silence, independently corroborated boundaries, and stable outside neighbors when a chain needs a split. Avoid dividing an adjacent timing conflict if an earlier safe cut exists.
5. All reviewed indices belong to exactly one repair assignment. Do not emit context-only alignments or duplicate writes. Check accepted proposals against actual outside neighbors before commit.
6. A cap is not evidence of a word boundary. Unsupported proposals remain unresolved; no forced normalization that silently loses a sounding body.

## Regressions to run before and after

- The concrete 100-word/33-review chain, for Russian and Ukrainian spelling.
- Dense reviewed chains: independent word and time budgets; target coverage exactly once; output text and ordering preserved.
- A long instrumental gap: choose silence rather than include unrelated audio in one review.
- A nearby reliable boundary/onset: choose it over a numerical cut through a conflict.
- Two conflicting adjacent words around the nominal cap: keep joint ownership and retain the successful neighboring-word correction.
- No reliable seam in a long conflict chain: bounded attempts, no new cross-window overlap, unresolved evidence kept visible.
- Neighbors remain context on each ordinary isolated reviewed span; no target or changed neighbor overwritten by a later repair.
- One sustained word exceeds the duration cap: one complete, non-clipped word review.
- Existing reviewed-word acceptance, confirmed entry, strong neighbor-end preservation, sub-80-ms word, fallback rejection and final pipeline joint-commit tests.
- Synthetic real CTC emissions for RU/UK: isolated and split review agreement, source words retained, monotone starts/ends, and no extra model calls.

Root owns the final full backend and live-application gate reporting.
