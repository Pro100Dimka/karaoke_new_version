# Independent read-only review of the third-pass library patch

Reviewed 2026-11-19 against the working diff after `9d44f17dfa7fbc321c5dc8e8c8a722e9e511cfaf`.

## Outcome

**Two P2 regressions are unresolved in the reviewed snapshot.** Both arise because the new normal paged-catalog path applies an existing client predicate to rows already matched by the backend, whose text normalization and duration boundary differ. Root and `visible_library_audit` received both reproductions. The owner is preparing corrections; this report does not assert those later corrections are complete.

No product or test source was edited by this reviewer. No full suite was run. The editor was excluded and was not reopened.

## P2 — Correct server search matches disappear after the new client text filter

Location: `frontend/src/pages/library/songs/useLibraryCatalog.ts`, new non-placeholder `filterLibrarySongs(songs, serverFilter)` call; text predicate in `librarySelectors.ts`.

`normalizeSearch` in `frontend/src/shared/utils/format.ts` uses NFKC plus `toLocaleLowerCase()`. The backend's `normalize_search` in `python/backend/text_normalization.py` uses NFKC plus `strip().casefold()`. `python/backend/infrastructure/sql_songs.py::_text_match` searches stored normalized title, artist and original filename using that casefolded query.

Two ordinary valid metadata/search pairs:

| Title | Search | Backend normalized strings | Result from actual patched selector |
| --- | --- | --- | --- |
| `Straße` | `STRASSE` | `strasse` / `strasse` | `[]` |
| `ΟΣ` | `οσ` | `οσ` / `οσ` | `[]` |

The current selector was bundled in memory with esbuild and executed without changing repository files. Given each matching server row, its new filter returned an empty array. The actual backend normalization function was separately compiled from its AST and evaluated; containment was true for both pairs. The SQL predicate uses exactly that normalized containment.

Before this diff, normal paged results were retained in server order and these matches were visible. The mismatch previously existed in full-catalog modes, but the new call extends the loss to ordinary search. When all rows disappear, `LibrarySongs` renders the empty state instead of VirtualGrid, also preventing its next-page trigger.

Recommended proof for the owner: a `useLibraryCatalog` regression where `searchSongs` returns each valid match and `completeCatalog === false`; include a non-null next cursor/control for preserving server ordering and pagination. Align matching semantics or distinguish trusted server rows from locally injected rows.

Important implementation constraint: the separate `['song-imports']` cache identifies pending placeholders, but `importSong` also injects a completed optimistic SongDto into page zero of every `['songs']` query cache, without an origin flag. Trusting all page rows and filtering only `song-imports` would reopen the original optimistic cache pollution issue. This was communicated to the owner.

## P2 — Exactly five-minute songs disappear from both paged duration filters

Location: the same new paged filter call and `librarySelectors.ts::durationMatches`.

Backend `_search_filters` defines:

- Medium: `duration >= 180 && duration < 300`.
- Long: `duration >= 300`.

Current frontend defines:

- Medium: `seconds >= 180 && seconds <= 300`.
- Long: `seconds > 300`.

For a normal ready song with `durationSeconds: 300`, the server Long query returns the row but the new client Long predicate removes it. The server Medium query excludes it, so normal paged browsing cannot find that song in either duration group. The actual current selector probe returned `['five-minutes']` for Medium and `[]` for Long, confirming the discrepancy against the backend SQL contract.

The filtering patch should use one common boundary contract; matching the existing server predicates avoids changing the established normal paged behavior. Add exact-300s Long and Medium controls, with adjacent 180/300 boundaries as appropriate. Existing new tests use 360 seconds and do not detect this loss.

## Reviewed paths and non-findings

Reviewed all changed logic and new/changed tests in:

- `frontend/src/pages/library/songs/index.tsx`
- `frontend/src/pages/library/songs/useLibraryCatalog.ts`
- `frontend/src/pages/library/songs/librarySelectors.ts`
- `frontend/src/pages/library/songs/LibrarySongs.selection.test.tsx`
- `frontend/src/pages/library/songs/LibrarySongs.deletion.test.tsx`
- `frontend/src/pages/library/songs/useLibraryCatalog.test.tsx`

Traced contracts read-only through `components/api-service.ts`, `services/pythonClient.ts`, `services/pythonMappers.ts`, `shared/utils/format.ts`, `application/room/roomLibrary.ts`, `SelectionToolbar.tsx`, backend song routes, SQL search, and text normalization.

Selection cleanup appears correctly scoped: it runs only while selecting, after successful complete data is present, and skips fetching, placeholder and error states. It reconciles against `localSongs`, so changing search visibility does not erase selected existing songs and remote room cards do not become local deletion targets. The complete catalog query uses `pythonClient.listSongs`, which exhausts all cursors before resolving; cleanup is therefore not using a partial page. Functional state updates preserve concurrent still-existing selections.

The paged filter preserves server order for non-recent sorts and retains the pre-existing recent-sort behavior. No extra cursor manipulation was introduced. Placeholder data intentionally keeps the prior search result visible, with playback/selection disabled elsewhere; it is excluded from selection cleanup. Error states likewise preserve selection. No additional confirmed regression was found in those flows.

The actual card-deletion test exercises real LibrarySongs/query/card/dialog behavior, while the separate loading/placeholder/error tests intentionally stub catalog states. The pending-import tests cover query, ready, language, long-duration and importing cases, including real search/filter controls, but omit the two server/client contract disagreements above.

This is a source/contract review with targeted in-memory runtime probes, not a visual/live Electron assessment. No new assertion that every library bug has been found is made.

## Follow-up review: both introduced P2 findings resolved in the frozen correction

This section supersedes the unresolved status of the earlier snapshot above, which is retained unchanged as review history. The follow-up was limited to the two findings and the cache-boundary adjustment needed to address them. No source edits or extra test runs were performed by this reviewer.

### Trusted server search rows

The revised `useLibraryCatalog` no longer reapplies client text matching to persisted server rows in normal paged mode. It builds a set exclusively from the separate `['song-imports']` IDs, removes matching imports from that set, then hides only the remaining nonmatching import IDs. Other server rows retain their membership and order; the existing recent-sort behavior is retained.

The accompanying `api-service.ts` correction limits optimistic insertion of completed imports to complete catalogs, using `queryKey[2] === null`, consistent with `songsQuery`'s actual key contract. Filtered page contents and their cursors are not mutated by the insertion. The existing `refreshSongs` call still invalidates/refetches search queries, so completed imported songs appear through the backend's matching and cursor-order contract. This addresses the earlier review's warning that filtering pending placeholders alone would otherwise leave completed optimistic imports polluting filtered caches.

The new hook regression returns the valid `Straße`/`STRASSE` and `ΟΣ`/`οσ` backend matches with `nextCursor: 'next-server-page'`; it asserts the song remains visible in paged mode, `hasNextPage` stays true and the cursor is retained. The new cache test calls the actual import/cache path and proves full-catalog insertion, unchanged filtered page content/cursor, filtered-query invalidation and placeholder cleanup.

**Resolution is specifically the newly introduced paged-search regression.** The older full-catalog text-normalization mismatch is not fixed by trusting server pages and is not claimed resolved here. That issue is being investigated separately. This follow-up does not assess or approve a general Unicode normalization change.

### Five-minute duration boundary

The current frontend selector now uses Medium `180 <= seconds < 300` and Long `seconds >= 300`, matching the inspected backend contract. Tests exercise exactly 300 seconds in both paged and complete-catalog modes for both filters. The new paged path also preserves the backend's persisted duration results directly. The introduced loss of 300-second songs is resolved, and the existing complete-catalog boundary inconsistency is corrected by the same predicate adjustment.

### Evidence inspected

- `third-library-search-contract-red.log`: actual pre-correction **6 failed / 9 passed**, including 2 casefold match losses, 3 failing 300-second cases, and completed-import pollution of a filtered cache.
- `third-library-search-contract-green.log`: **2 files / 15 tests passed** after correction.
- `third-library-focused-final.log`: **8 files / 30 tests passed** on the owner's frozen source.
- `third-library-typecheck-final.log`: no errors; owner reports exit 0.
- `third-library-architecture-final.log`: architecture check passed.
- `third-library-format-final.log`: all checked files use Prettier style.

These are inspected owner-generated logs, not additional test executions by the independent reviewer. The source and assertions were re-read directly. No new confirmed regression was found within this targeted correction review.

### SHA-256 of re-reviewed correction files

| File | SHA-256 |
| --- | --- |
| `frontend/src/pages/library/songs/useLibraryCatalog.ts` | `366ec41bb57f773340fa687ac2e831529263858059fee825c9ab905ba2cab74b` |
| `frontend/src/components/api-service.ts` | `3931c2d20c89caea0cfa9aae772c76ed39077af3f95bd2707dabb9ad26015d26` |
| `frontend/src/pages/library/songs/librarySelectors.ts` | `3ffcd0b37988a01a77624b2b38ce3e139d344ca16e19f2b67e4d1be0ea18a0ce` |
| `frontend/src/pages/library/songs/useLibraryCatalog.test.tsx` | `0b4719e2c33c3575f2382cfecbb5d5b72220ae2d497b519112d6117c9a26b687` |
| `frontend/src/components/api-service.import.test.ts` | `0640481c1de8726f5015f9972c12b186a40039354163692aec492b8233e0fa00` |

## Final follow-up: complete-catalog casefold correction reviewed

The separately implemented folding correction now addresses the older full-catalog mismatch left open in the preceding follow-up. Reviewed `format.ts`, the generated JSON, its generator, and both new folding tests read-only. No additional finding was identified in this targeted diff.

The renderer applies native NFKC once, iterates Unicode code points with `Array.from`, and looks each up in the complete generated Unicode 15.0.0 default-casefold table with identity fallback. It performs neither locale-dependent lowercasing nor an incorrect uppercase/lowercase approximation. Multi-character mappings are preserved. Dotless `ı` has no replacement and remains distinct from ASCII `i`; dotted capital `İ`, Cherokee's uppercase default fold, supplementary-plane characters, and Greek final/contextual sigma are covered. The generator enforces Unicode 15.0.0 and its `--check` compares the exact generated file, not just selected examples.

Inspected actual owner evidence: **13 failed / 7 passed** before correction; **34 passed across 3 focused files** afterward; generator check reports **all 1,530 mappings**. The real catalog-hook tests preserve previously visible server matches in title, artist and filename when switching to selection/full-catalog mode, and title matches when switching to playlist mode. A negative dotless-i control prevents over-collapsing different characters. Runtime `normalizeSearch` call sites are limited to library selectors/search/sorting; no processing or DSP path was changed.

This closes the known default-casefold mismatch, **not every Unicode normalization difference**. Native JavaScript NFKC remains unchanged. The documented Node Unicode 17 versus Python Unicode 15 difference for 37 scalar values unassigned in Python's version remains outside this correction; scalar comparison does not establish equivalence for every multi-code-point string. Existing caller trimming is also unchanged. No claim of complete Unicode normalization equivalence or live Electron validation is made.

Re-reviewed SHA-256 values match the owner's frozen report:

| File | SHA-256 |
| --- | --- |
| `frontend/src/shared/utils/format.ts` | `ac27de9f6960cf4e89abe704cf8d1342267f1d1124fee0e758224d3f98674cb2` |
| `frontend/src/shared/utils/searchCasefold.generated.json` | `1d39267f5aefdade61b8c766ab4702de680746c1f9bdd80563c4ec3d0ffd5c4d` |
| `frontend/scripts/generate-search-casefold.py` | `291a3879b1ccc8fa96ffcab6011128ff6db80387e898f7ebae44a3f66b56e6b7` |
| `frontend/src/shared/utils/format.search-folding.test.ts` | `499d02186a43eb500c0a598caa9c1733d66f3e25ee9ec6b548394fe0a688367f` |
| `frontend/src/pages/library/songs/useLibraryCatalog.search-folding.test.tsx` | `61a202f890b3229b2ac8bdf7733909114660aef8a82dd25821164a9e81524a74` |
