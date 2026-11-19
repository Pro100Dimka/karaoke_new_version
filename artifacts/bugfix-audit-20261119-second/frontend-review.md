# Second renderer audit — 2026-11-19

Base for this pass: `34eae170d0a12beea5ae48421fe334b93dda7969`.
Worktree: `/workspace/scratch/726a7fe1e251/karaoke_new_version`.
Branch: `fix/app-bugs-excluding-processing-20261119`.

## Source freeze

Renderer source and regression tests are frozen after the focused verification recorded below. This agent made no commit, push, PR, Electron/backend/native change, or full-suite run. Root owns integration and publication. Eleven renderer files are changed or added, all listed below. The processing hook in `useSongActions.ts`, song processing, AI/ASR/separation/alignment/pitch/DSP, and ADMaster/analysis/studio implementation, tests, and configuration were not changed.

## Five additional reproduced defects

### 1. Manual room radio failures disappeared into unhandled rejections

`providers/radio.tsx` already observed initial host publication failures, but manual `toggleRadio` and `setRadioStation` discarded the promise from `publishRadio`. A rejected `RoomLibraryCoordinator.publishSharedState` produced an unhandled rejection and did not reach the existing operation-failure notice channel.

Both manual paths now use the existing `observeOperation('errors.radioMetadata', ...)` handling and consume the rethrown promise. Room state remains authoritative; failed requests do not optimistically enable radio or switch the shared station. A subsequent user action can retry.

Actual RED: two failing cases, fifteen existing passes, and two unhandled rejections. GREEN: 17/17 radio tests. Log prefixes: `second-frontend-radio-red.log`, `second-frontend-radio-green.log`.

### 2. Clearing the artist silently retained incorrect metadata

The real song-settings form converted `artist.trim()` to `undefined` when empty. The PATCH contract treats an omitted artist as unchanged. The backend supports an explicit empty string, so the input looked cleared and the dialog closed while the old artist survived.

The form now sends the trimmed string, including `''`. Title behavior is unchanged. Tests operate the real form controls and submit button, covering both an empty input and whitespace-only input.

Actual RED: two failures showing the received PATCH artist was `undefined` instead of `''`. GREEN: 2/2. Logs: `second-frontend-song-settings-red.log`, `second-frontend-song-settings-green.log`.

### 3. An empty room library was never published on startup/recovery

`RoomLibraryPublisher` initialized its last published key as `''`; a successfully loaded library with zero ready songs also hashes to `''`. Therefore the first empty publication was skipped. After backend recovery with all formerly shared songs deleted, the remote room could retain the old shared catalog.

The unpublished sentinel is now `undefined`. A successfully read empty library publishes once for the current publishing lifetime, without re-publishing each polling tick; a new lifetime after backend recovery publishes its actual snapshot again.

Initialization safety was checked explicitly: publication awaits `python.listSongs()`, not a store placeholder. A pending first read does not publish anything. If the backend becomes unavailable before that read finishes, its late empty result is ignored. A later successful ready lifetime may publish the genuine empty result.

Actual RED: initial empty publication missing (zero calls), and reconnect-to-empty missing (one call instead of two). GREEN: initially 19/19; final 20/20 after the pending/retired-read safety case. Logs: `second-frontend-room-library-red.log`, `second-frontend-room-library-green.log`, final combined log below.

### 4. Seeking during preview startup lost ownership of the playing audio

`useRecordingPlayback` set its ownership ref before asynchronous loading. A waveform seek during that loading interval queried preview status before a recording was assigned, saw `recordingId: null`, and cleared ownership. Loading later succeeded, but the next Pause action started playback again, and closing the player skipped owned-preview stop/cancellation. Closing during that pending load had the same cancellation hole.

The hook now tracks its own pending load. Waveform actions during that interval store the requested initial position without treating the not-yet-loaded status as ownership loss. Cleanup can still cancel the owned load; once loading succeeds the queued position is applied and Pause uses the owned preview correctly. Existing generation checks and normal lost-ownership behavior remain in place.

Actual RED: cleanup made zero stop calls; Pause made zero pause calls. GREEN: 4/4 hook cases and 13 existing audio-player cases (17 combined). Logs: `second-frontend-recording-preview-red.log`, `second-frontend-recording-preview-green.log`.

### 5. The desktop Online Room action was ignored

The desktop launch/Jump List route produces `{ type: 'openRoom' }` without an invitation code. `DesktopShellBridge` correctly queues it, but `useLibraryDesktop` only invoked its opening callback if a code was present. Consequently an ordinary desktop Online Room command did nothing, including after waiting for backend readiness.

The existing callback now accepts an optional code and is invoked for both normal room entry and invitation links. The library page opens the same room dialog and clears any absent invitation code. Import and processing dispatch were not changed.

Actual RED: immediate no-code open and queued no-code open both failed; invitation-code case already passed. GREEN: 3/3 hook cases and five existing desktop-shell bridge cases (8 combined). Logs: `second-frontend-desktop-room-red.log`, `second-frontend-desktop-room-green.log`.

## Changed file inventory

Production:

- `frontend/src/providers/radio.tsx`
- `frontend/src/pages/library/modals/song-settings/index.tsx`
- `frontend/src/application/room/RoomLibraryPublisher.ts`
- `frontend/src/pages/library/modals/recordings/useRecordingPlayback.ts`
- `frontend/src/pages/library/useLibraryDesktop.ts`
- `frontend/src/pages/library/index.tsx`

Tests:

- `frontend/src/providers/radio.test.tsx`
- `frontend/src/pages/library/modals/song-settings/index.test.tsx` (new)
- `frontend/src/application/room/RoomProjectCoordinator.test.ts`
- `frontend/src/pages/library/modals/recordings/useRecordingPlayback.test.tsx`
- `frontend/src/pages/library/useLibraryDesktop.test.tsx` (new)

## Verification after final source changes

Commands ran from `frontend/`:

```
./node_modules/.bin/vitest run src/providers/radio.test.tsx src/pages/library/modals/song-settings/index.test.tsx src/application/room/RoomProjectCoordinator.test.ts src/pages/library/modals/recordings/useRecordingPlayback.test.tsx src/services/audioPlayers.test.ts src/pages/library/useLibraryDesktop.test.tsx src/app/desktop/DesktopShellBridge.test.tsx
./node_modules/.bin/tsc -b tsconfig.app.json --pretty false
node scripts/check-architecture.mjs
```

Results: **7 suites / 64 tests passed**, renderer TypeScript passed, architecture passed. Formatting was applied to exactly the eleven changed/added renderer paths; `git diff --check -- frontend/src` passed. Logs:

- `/workspace/scratch/726a7fe1e251/second-frontend-focused-final.log`
- `/workspace/scratch/726a7fe1e251/second-frontend-types.log`
- `/workspace/scratch/726a7fe1e251/second-frontend-architecture.log`
- `/workspace/scratch/726a7fe1e251/second-frontend-format.log`

Full frontend/Vitest/Electron and other domain gates remain root's responsibility after all agents freeze.

## Coverage of this second pass

This is a concrete coverage record, not a claim that every possible defect in the repository has been found. The following modules and connected scenarios were inspected beyond the newly added tests.

| Area | Modules inspected | Scenarios traced |
| --- | --- | --- |
| Radio | `providers/radio.tsx`, `providers/store.ts`, `services/youtubeRadio.ts`, radio tests | Local and room ownership, manual publishing, backend/audio epoch changes, stale preparation/play completion, EOF advancement, participant authority, unmount |
| Library | `songs/useLibraryCatalog.ts`, `songs/index.tsx`, `songs/librarySelectors.ts`, `songs/SelectionToolbar.tsx`, `songs/song-grid/index.tsx`, `songs/useRoomLibrary.ts`, `hero/filters&actions/useLibraryView.ts`, `components/api-service.ts` catalog portions | Full catalog versus server pagination, filtered selection, playlist catalogs, placeholder data, deletes, pending imports, refetches, sorting, remembered scroll |
| Playlist/preferences | `features/playlists/PlaylistDialog.tsx`, `shared/preferences/preferences.ts` relevant fields/parser, `application/library/songPreferences.ts`, `shared/storage/localStore.ts`, `providers/store.ts` | Playlist ordering/removal/playing, unavailable songs, save and local reload, selection of saved lists, local preference validation |
| Editor session | `pages/editor/useEditorSession.ts`, `editorDraft.ts`, `index.tsx`, `editorApi.ts`, `application/editor/editorModel.ts` save/dirty/history boundaries, existing session tests, `providers/close-guards.tsx`, `providers/dialog.tsx` | Dirty state, save in flight with more edits, duplicate saves, revision conflict cancel/reload/overwrite, late saves after a new song, recovery drafts, unmount, shortcut/dialog ownership |
| Metadata/preview | Song-settings `index.tsx`/`rows.tsx`, recording `useRecordingPlayback.ts`, `RecordingPlayer.tsx`, `takeNames.ts`, `services/audioPlayers.ts` | Form submission and explicit clearing, media preview cleanup, audio ownership across asynchronous loading/seeking/pausing/unmount, failed seeks, take ordering |
| Room coordination | `RoomLibraryPublisher.ts`, `RoomLibraryCoordinator.ts`, `RoomSessionController.ts`, `roomNavigation.ts`; scoped `RoomProjectCoordinator.ts` publication/retry/cancel/selected-artwork paths and its existing tests | Initial/recovered library publication, pending reads, paused generations, stale room scope, leave/join compensation, selection and navigation authority, project retry/cancellation |
| Social | `providers/social.tsx`, `features/social/useRoomPeople.ts`, `usePersonPhoto.ts`, `useSocialAction.ts`, `application/social/FriendRelationsCoordinator.ts`, friends `requests.tsx`/`history.tsx`; prior social client/invitation changes read in baseline report | Offline remounts, stale asynchronous people/photo requests, friend relation refresh, request pending state, invitation ownership/retry continuity |
| Settings | Environment `useEnvironmentSettings.ts`/`useEnvironmentJson.ts`; advanced `useStorageCleanup.ts`, `history/useHistory.ts`, `diagnostics/useDiagnosticsActions.ts`; appearance `keyboardlighting/useKeyboardLighting.ts` | Debounced persistence and unmount flush, write serialization, stale verification, newer JSON draft preservation, confirmation locks, pagination retries, optional polling cleanup |
| Desktop/TV/lifetimes | `useLibraryDesktop.ts`, library page and modal boundaries, `app/desktop/DesktopShellBridge.tsx`/`shellBus.ts`, `app/useWindowState.ts`, `useAppOnScreen.ts`, `providers/services.tsx`, scoped `StartupRecovery.tsx`/`AppCloseFlow.tsx`, `KaraokeHost.tsx`, TV `useTvWindow.ts`/`karaokeTv.ts`, `usePianoRollLayout.ts`, `shared/ui/useDetachedPanel.ts` | Command queuing/replay, room opening, invitation links, stable callback refs, service readiness, TV queue continuation and return, secondary-window lifecycle/persistence |
| Karaoke lifecycle (application layer only) | `useKaraokeLoadSession.ts`, `karaokeAudioLifecycle.ts`, `usePositionPolling.ts`, `useAudioRecovery.ts`, `useKaraokeShortcuts.ts`, `performanceFinish.ts` | Current-session guards, teardown, polling cancellation, recovery retry, keyboard/dialog ownership; no DSP/processing changes |

## Rejected or deferred hypotheses

- Playlist dialogs do **not** rely on only the currently visible server page: opening playlists or selection requests the unfiltered complete `listSongs()` catalog. Missing later pages was not reproduced.
- The apparent duplicate room-history React keys were rejected after reading the backend history grouping: it emits one aggregate stay per room ID, not one row per reconnect.
- Radio preparation and play completion already compare generations. Late failed play results after disable and stale loads after unmount have existing regression coverage; no speculative rewrite was made.
- Editor save results already guard the session generation and retain edits made during a save. A hypothetical stale unsaved-dialog decision after an unrelated route change was not promoted to a fix without a traced supported UI path; desktop import/room commands explicitly wait while the editor is open.
- Environment writes already serialize per key, flush pending drafts on unmount, cancel stale reads, and ignore verification against a replaced cached entry. JSON edits have a separate generation so an older Apply result cannot clear newer text. No rewrite was justified.
- Social people/photo loads already retire their active requests on dependency changes/unmount. Room history and friend action paths did not establish an additional account-state defect in this pass.
- A potential out-of-order waveform seek was not treated as a confirmed transport defect: actual command/diagnostic ordering and the confirmed pending-load ownership issue were distinguished. Only the reproduced pending-load ownership path was changed.

## Remaining live validation limits

The tests are component/application tests with mocked service boundaries. They prove the listed control-flow regressions, not live Windows multi-window or actual sound behavior. In particular, room empty-library propagation/recovery and radio failure/retry require the repository's real two-window `start-multy.bat` gate; desktop Jump List/launch integration and preview cancellation/pausing require live Electron/audio checks. TV/room device switching, rendered detached windows, actual audio timing, and remote-network behavior were not live-verified on this Linux environment. No complete/ready declaration is made for those features.
