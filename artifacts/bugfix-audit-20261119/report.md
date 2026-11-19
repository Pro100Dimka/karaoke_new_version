# Application bug audit — 19 November 2026

## Scope and status

Branch: `fix/app-bugs-excluding-processing-20261119`
Base: `main` at `b7e3aec091faa8896450cbe575cda4ab92544b13`
Source commit tested: `2bf1efcc8fde65a49de62a9d1c8c519e4ca09dda`

The requested exclusions were song processing and AD Master. The patch addresses library storage, package import boundaries, ordinary playback state, desktop lifecycle and social invitation handling. The changes are isolated from the pre-existing AD Master worktree. Nothing is merged into `main`.

**This is a draft change with automated regression evidence. Windows live verification is incomplete.** Full automated suites were executed without excluding failing cases. The remaining failures and their baseline comparisons are recorded below; this report does not claim a globally green release or absence of every latent bug.

[Protected scope comparison](protected-scope.json) records byte comparisons and SHA-256 hashes for **151 protected source/test files**, all unchanged from the base. Independent review additionally checked mixed-file method boundaries and unchanged build/dependency/configuration files. There are no new skipped tests or weakened thresholds.

## Implemented changes and regression coverage

### Library, files and backend boundaries

| Observed defect | Implemented behavior | Regression suite |
| --- | --- | --- |
| An interrupted cover copy could truncate the selected cover; selecting the managed cover again failed with a same-file error. | Copy to a unique temporary file, fsync and atomically replace. Reuse an existing identical source/destination. | `test_library_file_operations.py` |
| A failed metadata save could replace a cover or clip despite rolling back SQL; an invalid cover could fail after a valid clip had already been copied. | Validate both inputs first. Serialize manual saves per song, preserve only requested destinations and roll back their files if validation/copy/metadata/commit fails. Mark media committed immediately after SQL commit. | `test_song_media_transactions.py`, `test_song_media_update_storage.py` |
| Deleting a recording whose owned directory was already missing repeatedly failed. | An absent owned directory and absent quarantine are tolerated while path/ownership checks and other I/O errors remain enforced. | `test_library_file_operations.py`, existing transaction recovery tests |
| A valid imported package could reuse another song's ID and replace its active project. | Reject source/ID collisions during inspection and recheck identity before committing metadata; preserve existing same-source remapping. | `test_package_identity_collision.py`, existing package E2E/security/migration suites |
| Concurrent identical invitations or accept/decline calls could create duplicates or contradictory answers. | Serialize invitation creation, answer and expiry mutations. Live room verification remains pending. | `test_social_invite_concurrency.py`, `test_social.py` |
| Concurrent cover downloads shared a temporary filename; oversized responses were fully allocated; cache errors could become HTTP 500. | Unique temporary files, bounded decoded streaming to 8 MiB, and consistent unavailable-artwork handling for cache/network failures. | `test_artwork_cache_failures.py` |
| Non-finite/negative durations and oversized package integers could reach database or numeric conversion failures. | Validate finite non-negative durations and non-negative signed 64-bit integer fields before import. | `test_package_metadata_validation.py` |
| Non-ASCII avatar Base64 escaped the normal validation response. | Return the existing unsupported-avatar validation error. | `test_social_avatar_validation.py` |

Manual media transaction boundaries also cover first-time files, both-media SQL failure, a later copy failure, managed-file reselection, post-commit cleanup failure, simultaneous manual saves, retained backups after failed restoration and non-fatal successful-save cleanup. Existing concurrent processing publication behavior stays covered and unchanged.

### Interface and playback lifecycle

| Observed defect | Implemented behavior | Regression suite |
| --- | --- | --- |
| Leaving the library during its delayed launch still navigated to karaoke; rapid clicks scheduled multiple launches. | Own and cancel the launch timer and admit one scheduled launch. The processing hook remains unchanged. | `useSongPlayback.test.tsx` |
| Editor playback inherited the previous song's cursor or stale async results; duplicate toggles and premature seeks were possible. | Reset preview state per audio generation, reject stale completions, guard readiness and serialize pending toggles. | `useEditorPreview.test.tsx` |
| Recording seek-status errors escaped; a failed initial seek could leave audible playback with idle controls. | Catch the entire seek flow and stop an owned preview after failed setup. | `useRecordingPlayback.test.tsx` |
| Selection controls vanished when filtering hid all selected songs. | Keep the selection toolbar available with empty results. | `LibrarySongs.selection.test.tsx` |
| Last-played sorting did not update while the library remained mounted. | Publish and subscribe to local last-played changes. | `useLibraryCatalog.test.tsx` |
| Two synchronous social actions could bypass the busy state. | A synchronous pending ref prevents duplicate dispatch and releases on failure. | `useSocialAction.test.tsx` |
| Failed automatic requested-room acceptance offered no retry; server acceptance followed by local join failure consumed the invitation permanently. | Retain the accepted room target and invitation snapshot; retry local entry without a second server acceptance. Keep Retry/Close after inbox removal or temporary offline remount; ordinary pending invitations still expire. No automatic failure loop. Live room verification remains pending. | `SocialAlerts.test.tsx`, `RoomInvitationCoordinator.test.ts` |
| Failure loading the initial social snapshot caused an unhandled rejection. | Emit offline only while subscribed and before any newer pushed snapshot. | `socialClient.test.ts` |
| A saved playlist stopped after its first song on TV. | Continue the saved playlist when the TV queue is empty; an explicit TV queue retains precedence and clears the displaced automatic playlist. Live TV verification remains pending. | `KaraokeHost.playlist.test.tsx` |

### Desktop and native playback

| Observed defect | Implemented behavior | Regression suite |
| --- | --- | --- |
| Close-to-tray could hide the last restore control; late status events could recreate a destroyed tray. | Verify a usable tray before hiding and remove the status listener on destruction. | `TrayRadio.test.ts` |
| A crashed/reloaded renderer could leave display sleep disabled. | Bind the display blocker to its renderer and release it on destruction, process loss or full main-frame navigation. | `DesktopIpc.displayAwake.test.ts` |
| A slow older OpenRGB write could override Off or a newer setting. | Serialize hardware writes and skip obsolete pending revisions while preserving error recovery. | `KeyboardLighting.test.ts` |
| Structured diagnostic room/device/API credentials and Basic authorization were incompletely redacted. | Recognize supported quoted key forms and authorization prefixes before diagnostic upload/storage. | `AppLogUploader.test.ts` |
| ASIO installer size validation happened after allocating the whole response. | Stream to the existing 8 MiB limit and cancel/release rejected bodies; pinned URL/version/hash stay unchanged. | `Asio4AllInstaller.test.ts` |
| A truncated FLAC silently looked like normal EOF. | Report premature EOF when the stream advertises more frames; retain valid EOF, exact-end seek and replay behavior. No sample processing changes. | `flacDecoderRejectsTruncatedAudio`, `flacDecoderReadsAndSeeksAtTheExactEnd` |
| Repeated suspension lost whether playback had been running. | Treat an already suspended session as a no-op so resume restores the original prepared/running state. Active recording protection stays unchanged. | `repeatedSuspendPreservesTheResumeState` and existing suspend/recording guards |

## Full verification

Linux container, Node 24.22.3, Python 3.12, GCC 14, Release native build with warnings treated as errors. The native build uses the repository's pinned dependencies. No dependency or configuration changes were made. Windows `check.bat` commands cannot run here; their relevant underlying commands were run with complete affected suites, sequentially. Complete output and exact exit codes are recorded in [verification.json](verification.json) and `logs/`. Readable log copies omit trailing line whitespace; metadata retains both original-output and saved-copy hashes.

| Check | Result after the relevant final source edit |
| --- | --- |
| Frontend renderer/Electron types | PASS |
| Frontend architecture | PASS |
| Full Vitest | **1183 tests passed; 169 suites passed, 1 suite failed during collection** |
| Full Electron/Node script tests | **109 passed, 5 platform skips, 0 failed** |
| Production frontend build | PASS; existing large-bundle warning remains |
| Backend compile, architecture, bootstrap | PASS |
| Backend Ruff lint and mypy `--platform win32` | PASS |
| Backend required format gate | FAIL: 10 pre-existing unformatted files; clean base reports 11, including the touched import file now formatted |
| Full backend pytest | **2138 passed, 3 failed, 10 skipped** (327.09 s); the three failures reproduce on clean base |
| Native Release build, warnings as errors | PASS |
| Full registered CTest | **2 of 3 CTest entries passed; main native runner: 507 passed, 4 failed cases** |
| Whitespace/diff check | PASS |

### Baseline comparisons for every remaining failure

1. **Frontend AD Master preparation suite:** `src/pages/library/modals/analysis/preparation.test.tsx` fails because its `@neo-ui-kit/react` mock lacks `setLocale`. The same collection failure was reproduced on a separate clean checkout of `b7e3aec`. This excluded test was not modified.
2. **Backend AD Master:** `test_studio_master_keeps_the_recorded_balance_wet_effects_and_take_duration[balance]`, `[effects]`, and `test_seek_reference_contains_only_performed_sections[1.25-2]` fail unchanged on both the branch and the clean base. Their mastering code, test expectations and thresholds were not modified.
3. **Backend formatting:** the remaining 10 files are also unformatted on the clean base, including `studio_spectrum.py` and excluded processing tests. The report preserves the failing gate instead of bulk-editing excluded code.
4. **Native Unix IPC:** `controlPipePreservesRepliesAfterServerClose` and `controlPipeStopCancelsIdleAndStalledClients` fail on both builds. A direct socket probe confirms `socket(AF_UNIX, SOCK_STREAM)` returns `EPERM` in this environment. No permissions or IPC tests were bypassed.
5. **Native recording transition:** `performanceRecordingDrainsBeforeDeviceGenerationChanges` has the same generation assertion failure on clean base, both focused and in full CTest. The existing active-recording suspension guard is unchanged.
6. **Native alignment fixture:** the branch's full run additionally failed `performanceAlignerPlacesVoiceOnTheMusicItWasSungTo` with shared zeros at 44.1 kHz. The ordinary clean-base full run passed this case. A targeted clean-base run pinned to one CPU reproduced the exact mix/dry/vocal failure; nearby normal and pinned runs can pass, demonstrating scheduling sensitivity. The unpaced fixture feeds two seconds of data through a one-second worker queue; shared-silence insertion after an overrun is a source-supported explanation, but the original full run did not log the overrun counter. See [affinity comparison](native-aligner-affinity-comparison.json). Protected recording/alignment code and this test remain unchanged.

Each confirmed defect was reproduced before its corresponding fix. Additional boundary and compatibility cases were also added. Focused compatibility suites remain green; their logs are included alongside the full runs. These results do not replace the outstanding Windows gate.

## Limits and remaining live verification

The repository's `AGENTS.md` requires real Windows `start-multy.bat`, two Electron windows and affected scenarios exercised through rendered UI. That environment is unavailable. Room invitations, project transfer, TV/karaoke lifecycle, actual microphone/remote playback, Shared/Exclusive/ASIO behavior and cleanup of real Windows processes therefore **cannot be declared complete or verified**. See the explicit [live verification status](../room-e2e/2026-11-19-app-bugs/verification-status.json). No screenshots, measured voice skew or hardware diagnostics are fabricated.

Manual media updates provide exception rollback and serialization of manual saves, not a new crash-recovery journal. Processing's background clip publisher does not share that lock. The file-identity guard preserves a newer publication already visible before rollback, but an external replacement between the identity check and rename/unlink remains possible. Eliminating that race requires coordination with the excluded background publisher or a storage-format change; neither was included. Failed restoration retains the backup and logs its location.

The patch leaves processing, ASR, separation, alignment, pitch, DSP and AD Master algorithms/configuration unchanged. No release or merge to main is performed by this audit.
