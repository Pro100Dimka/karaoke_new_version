# Third library audit — source freeze report

Repository: `/workspace/scratch/726a7fe1e251/karaoke_new_version`

Branch: `fix/app-bugs-excluding-processing-20261119`

Starting HEAD: `9d44f17dfa7fbc321c5dc8e8c8a722e9e511cfaf`

Scope: ordinary visible library, selection, playlists, search, song settings, appearance and advanced settings journeys. No song processing, AI, separation, ASR, alignment, pitch, DSP, AD Master/studio or analysis source/tests were changed. No commit, push, PR or full suite was performed by this agent.

## Confirmed defects and changes

### 1. Pending imports ignored active library filters

Reproduction: search for Adele or choose Ready / English / Long, then add an unrelated MP3. The normal paged library appended global pending-import cards without applying the active filters. A Queen import appeared under Adele, and an importing card appeared under Ready. Searching Queen while two differently named files imported also showed both. Switching to complete-catalog mode happened to apply the filters correctly, so the same library behaved differently while selecting cards or viewing playlists.

Cause: `useLibraryCatalog` combined `song-imports` with server-filtered pages, but only the complete-catalog branch called the local filter. Imported-song optimistic cache updates could also add entries before server filtering caught up.

Final change: apply the existing local selector only to IDs from the separate `song-imports` list and hide only nonmatching pending imports. Persisted server rows are trusted as returned, including backend text-search semantics and cursor order. Completed optimistic imports are inserted only into the complete unfiltered catalog (`queryKey[2] === null`); filtered searches refresh through the existing `refreshSongs` path. Recent sorting still calls the same comparator. Previous server search results remain visible while a replacement query loads. Import/processing execution is unchanged; the `api-service.ts` edit only narrows the UI cache-update target.

Actual RED: five failing cases, two existing passing cases, exit 1. The failures explicitly include an unrelated `import:<uuid>` in the returned visible list, or Adele in the Queen import search.

Initial GREEN: 7/7, exit 0. A further real Neo UI component interaction test types Queen, opens the actual filter popover and status Select, chooses Ready (zero pending cards) and Importing (only Queen). That run passes 8/8, exit 0. It uses real controls and the real catalog hook; backend requests are mocked and rendered list items expose the catalog output. Independent review then found a mismatch in the initial implementation's blanket post-filter (documented below); that implementation and its earlier source freeze are superseded by the final pending-only filtering described above.

### 2. Deleting a selected card left a nonexistent song selected and blocked playback

Reproduction: select the first of two ready songs, click Delete on that song's own card, then confirm. The card disappeared, but its ID remained in the selection. The selection toolbar remained, Add to playlist could still receive the nonexistent ID, and the remaining song's Play button stayed disabled until the user manually cancelled selection.

Cause: batch deletion explicitly removed selected IDs. Card/settings deletion only refreshed the catalog, and `LibrarySongs` never reconciled selection with deleted entries.

Change: after a successfully loaded complete local catalog, remove only IDs no longer present. No reconciliation runs on a partial catalog, missing data, fetching, placeholder data, or an error. Search-hidden songs therefore stay selected. The effect uses `localSongs`, not the filtered `visibleSongs` array.

Actual RED: 1/1 failed, exit 1. The reproduction uses real `LibrarySongs`, `useLibraryCatalog`, `VirtualGrid`, `SongCard`, `DialogView`, Neo UI Checkbox and Button controls. It selects via the checkbox and confirms through the actual dialog. Backend and absent jsdom layout are simulated; the unrelated recordings modal is stubbed. The failing assertion shows the surviving Cancel toolbar button after the card is removed.

GREEN after the fix: deletion plus the existing hidden-search-selection test, 2/2, exit 0. Final guard coverage additionally retains selection during loading, placeholder data, and errors, then confirms retention when the complete catalog recovers.

### 3. Exactly five-minute songs changed duration category between paged and complete catalogs

The backend defines Medium as 180 <= seconds < 300 and Long as seconds >= 300. The existing frontend selector used Medium <= 300 and Long > 300. A 5:00 song could therefore vanish from Long after selecting a card/opening a playlist, or incorrectly appear in Medium in the complete-catalog view.

Change: align only these two frontend duration predicates with the existing backend contract. Regressions exercise 300 seconds in both Medium and Long, with both paged and complete-catalog modes.

### Independent-review correction before final freeze

The first filter implementation also reapplied frontend text matching to every persisted server result. Review correctly identified that backend NFKC + casefold can match `Straße` with `STRASSE` and `ΟΣ` with `οσ`, while the frontend's NFKC + lowercase can reject them. No partial Unicode casefold was invented. The final implementation trusts the backend's persisted results and filters only transient pending imports; the cache-boundary fix prevents completed imports from bypassing server search.

Actual additional RED: 6 failed / 9 passed, exit 1, covering the two valid Unicode server matches, Long @ 300 seconds in both modes, Medium @ 300 seconds in complete mode, and the existing completed-import pollution of a filtered cache. GREEN after the final correction: 15/15 across the two relevant files, exit 0. Unicode regressions also retain the server's non-null cursor and `hasNextPage`; the cache regression preserves filtered page contents/cursor and verifies invalidation while the complete catalog receives its optimistic song.

## Changed files and frozen Git blob hashes

| File | Blob hash |
| --- | --- |
| `frontend/src/pages/library/songs/index.tsx` | `997fe666502aa7b78c05c2139d625092053d314a` |
| `frontend/src/pages/library/songs/librarySelectors.ts` | `65240e087ce3010e007529895c796a9819f850f0` |
| `frontend/src/pages/library/songs/useLibraryCatalog.ts` | `001ed0ec034d4062b6e877fa215d3552232a42b1` |
| `frontend/src/pages/library/songs/useLibraryCatalog.test.tsx` | `7d076518fbaa9eed787ee05676b3b363e22c5bfe` |
| `frontend/src/pages/library/songs/LibrarySongs.selection.test.tsx` | `5d4f8503f28d346afdfaa6d9a0b1c3632d12d7b0` |
| `frontend/src/pages/library/songs/LibrarySongs.deletion.test.tsx` (new) | `aadd03c70b9355dc3fe7725251b78f0d597a3a1e` |
| `frontend/src/components/api-service.ts` | `7fe66023f41e895761531f7e8449c3f758c15ede` |
| `frontend/src/components/api-service.import.test.ts` (new) | `a8783b5734e9e5fde6f75eacc0cf88b64727f7bd` |

Full owned diff reviewed after final edits. Source is frozen at these eight hashes. This final freeze supersedes the earlier six-file freeze.

## Verification

All log paths below are relative to `/workspace/scratch/726a7fe1e251/` and are outside the repository.

| Run | Result | Exit | Raw log |
| --- | --- | --- | --- |
| Filter reproducer before fix | 5 failed, 2 passed | 1 | `third-library-filter-red.log` |
| Filter reproducer after fix | 7 passed | 0 | `third-library-filter-green.log` |
| Added real search/status controls | 8 passed | 0 | `third-library-controls-green.log` |
| Selected-card deletion before fix | 1 failed | 1 | `third-library-selection-red.log` |
| Deletion and existing filter-selection guard | 2 passed | 0 | `third-library-selection-green.log` |
| Intermediate focused run (superseded freeze) | 7 files, 23 tests passed | 0 | `third-library-focused-green.log` |
| Search/cache/duration contract RED | 6 failed, 9 passed | 1 | `third-library-search-contract-red.log` |
| Search/cache/duration contract GREEN | 15 passed | 0 | `third-library-search-contract-green.log` |
| Final focused run after all source edits | 8 files, 30 tests passed | 0 | `third-library-focused-final.log` |
| Final renderer TypeScript | passed | 0 | `third-library-typecheck-final.log` |
| Final architecture check | passed | 0 | `third-library-architecture-final.log` |
| Final Prettier on all eight owned files | passed | 0 | `third-library-format-final.log` |
| `git diff --check` | passed, no output | 0 | tool output |

Final focused command, from `frontend`:

```sh
./node_modules/.bin/vitest run src/pages/library/songs/useLibraryCatalog.test.tsx src/pages/library/songs/LibrarySongs.deletion.test.tsx src/pages/library/songs/LibrarySongs.selection.test.tsx src/pages/library/songs/SelectionToolbar.test.tsx src/pages/library/songs/song-grid/index.test.tsx src/features/playlists/PlaylistDialog.test.tsx src/pages/library/modals/song-settings/index.test.tsx src/components/api-service.import.test.ts
```

Final checks:

```sh
./node_modules/.bin/tsc -b tsconfig.app.json --pretty false
node scripts/check-architecture.mjs
./node_modules/.bin/prettier --check src/pages/library/songs/index.tsx src/pages/library/songs/librarySelectors.ts src/pages/library/songs/useLibraryCatalog.ts src/pages/library/songs/useLibraryCatalog.test.tsx src/pages/library/songs/LibrarySongs.selection.test.tsx src/pages/library/songs/LibrarySongs.deletion.test.tsx src/components/api-service.ts src/components/api-service.import.test.ts
```

## Reviewed hypotheses not promoted into additional changes

- Reduced-motion library curtain: CSS shortens its animation to 1 ms rather than removing it, preserving the animation-end path. No stuck-curtain finding confirmed.
- Playlist dialogs missing songs outside the visible server page: opening the dialog already requests the complete catalog; no new finding.
- Selection controls disappearing when a search matches nothing: fixed in the earlier audit and still covered by the passing existing test.
- Artist clearing in song settings: earlier explicit-empty-string fix still passes the real form tests.
- Nested filter Select interactions: real Neo UI controls open, select Ready/Importing and invoke the correct callbacks in the new integration test.
- Playlist create, append/deduplicate, unavailable-song blocking and saved-order playback: existing focused component checks remain green; no playlist code changed.
- Appearance theme/language controls and song-settings save/media contracts were inspected without a newly proven ordinary-journey defect. No speculative validation or style changes were made.

## Limits

These are executable component and hook regressions in jsdom, not live Windows/Electron visual verification. The virtual-grid test supplies synthetic dimensions because jsdom has no layout engine. No screenshots or real audio/device behavior are claimed. Parent owns the complete frontend suite, build/integration checks, Windows live gate, final commit and publication. No Windows two-window room, project-transfer, multi-instance or audio-device scenario was modified or claimed verified by this agent.
