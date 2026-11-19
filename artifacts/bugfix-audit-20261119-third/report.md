# Third application audit — visible user journeys

Date: 2026-11-19. Branch: `fix/app-bugs-excluding-processing-20261119`.

Starting branch head: `9d44f17dfa7fbc321c5dc8e8c8a722e9e511cfaf`.
Tested and published source commit: `a0559a6faa3b44e6edc00b1d63ddb00ed8b36e67`.

The user requested another pass for obvious application problems, then excluded the editor. This pass focuses on observable library, saved-recording player, error-screen and room/social UI behavior. It adds no processing or AD Master work and creates no pull request. New editor changes were removed before the final verification; earlier committed work was preserved.

## Changes and executable evidence

| User journey | Observed problem and code correction | Evidence |
| --- | --- | --- |
| Import while using search or filters | Pending imports appeared despite a different search, Ready status, language or duration filter. Completed imports were also optimistically inserted into unrelated filtered caches. Only pending imports are filtered locally; completed optimistic insertion is limited to the full catalog. Trusted server rows, order and cursors remain authoritative. | Actual failing hook tests, real Neo search/popover/status controls, and import-cache contract regression. |
| Delete a selected song through its card | The deleted ID remained selected, leaving the toolbar active and other playback buttons disabled. Selection now reconciles against a successfully loaded complete catalog. Hidden results, fetching, placeholder data and failed reads preserve selection. | Real LibrarySongs, card, checkbox, dialog and virtual-grid component reproduction; layout dimensions and backend are simulated. |
| Filter a song lasting exactly five minutes | The frontend classified 300 seconds differently from the backend, so switching catalog modes changed results. Medium is now below 300 seconds; Long includes 300 seconds. | Both filters exercised in paged and complete-catalog modes. |
| Search while selecting songs or browsing a playlist | The complete local catalog used lowercasing instead of case folding, losing names such as Straße/STRASSE and Greek sigma matches. Local search now uses generated complete casefold data from the supported backend runtime. | Actual full-catalog selector RED/GREEN plus casing, normalization and nonmatching controls; full scalar comparison and its limits are recorded separately. |
| Mute a saved recording while it is loading | The visible knob reached zero but playback started with the earlier gain. The pending preview owner now retains its latest gain and applies it before Play. | Actual RecordingPlayer, RotaryKnob, playback hook and preview service together; metadata/native boundaries are simulated. Owner isolation and cancellation are also covered. |
| Close/minimize an application error screen | The frameless window lost its TitleBar when Python startup failed or rendering fell back to the error screen. These screens now render the existing controls and hand ownership back to the shell after recovery. | Real Neo components; two bootstrap RED cases and one rendering-fallback RED case; recovery proves a single toolbar. Desktop IPC is mocked. |
| Follow participants and friends in a room | RoomDock read observable state without subscribing to it, so ordinary room and friendship snapshots did not reliably refresh the dock. Its existing component is now an observer. | Real store and useRoomPeople component regressions. Child cards and external application boundaries are stubbed. Mandatory live two-window verification remains incomplete. |
| Answer a request to join a room | A one-shot notice disappeared on the next inbox push or social reconnect. Retained requests now survive these updates, remain retryable after failure, and disappear after approval, local dismissal or leaving the room. | Backend notice lifecycle traced read-only and component RED/GREEN. Mandatory live two-window verification remains incomplete. |

The first filter implementation introduced two regressions caught during independent review: backend Unicode matches could be discarded, and 300-second songs could be excluded from Long. Both were reproduced and corrected before the final source freeze. The earlier full run and original findings are preserved as intermediate evidence; they are not substituted for the final run.

## Final verification

All affected frontend checks were run after the last product/test edit, sequentially. The Linux commands are equivalents of the frontend portions of `check.bat`; the Windows batch file itself was not run.

| Check | Final result |
| --- | --- |
| TypeScript app and Electron | Passed |
| Architecture | Passed |
| Complete Vitest suite | 1254 tests passed; 180 suites passed; 1 unchanged AD Master suite failed during collection |
| Complete Electron/script Node suite | 109 passed, 5 platform skips, 0 failures |
| Production renderer build | Passed |
| Changed-file formatting and diff whitespace | Passed |

51 new regression cases are included relative to the starting branch's 1,203 passing Vitest cases. 24 source, test, data and generator files changed. Final source hashes are in `source-manifest.json`; commands, exit codes and raw-log hashes are in `verification.json`.

### Existing failure retained

`src/pages/library/modals/analysis/preparation.test.tsx` still fails during Vitest collection because its Neo UI mock omits `setLocale`. This excluded AD Master test is unchanged. The original-main reproduction is preserved in the first audit, and the second audit records the same failure. No failing suite was omitted and no threshold was weakened.

Backend, native service and Electron production source are unchanged in this pass. Their previous complete results remain documented in `../bugfix-audit-20261119-second/`; those older runs are not presented as new frontend verification.

## Scope and independent review

- All 151 protected processing/AD Master files remain byte-identical to original main (`b7e3aec091faa8896450cbe575cda4ab92544b13`).
- All 14 editor source/test files remain byte-identical to this pass's starting branch head. The temporary editor fix and test from the early investigation were removed when the user excluded that area.
- The import change only selects which renderer query caches receive an optimistic item; import execution, song processing and its backend contract were not changed.
- Preview changes concern loading-state gain ownership only; DSP, microphone capture, recording algorithms, room clocks and mixing were not changed.
- The protected hashes and editor comparison are in `protected-scope.json`.

Review details are in `library-review.md`, `library-independent-review.md`, `recordings-review.md`, `rooms-review.md`, `room-independent-review.md`, `window-player-review.md`, `window-independent-review.md`, and `search-folding-review.md`. Original review findings are preserved with resolution evidence rather than silently replaced.

## Live verification and remaining limits

Real Chromium launch was attempted and failed before a page opened: the environment rejected its process-singleton Unix socket with EPERM. The observed error and command context are recorded in `window-player-review.md`. No browser screenshots or live Electron result are claimed.

These tests exercise real controls where documented, but jsdom does not provide native layout, window IPC, audio output or dialog top-layer behavior. The Windows `start.bat` checks of error-screen controls and audible muted preview remain pending. The room changes require `start-multy.bat`, both real Electron windows, the affected rendered UI scenarios, and process cleanup; that acceptance gate has not been executed and room work is not declared complete. Machine-readable status is under `../room-e2e/2026-11-19-app-bugs-third/verification-status.json`.

Case folding is generated from Python Unicode 15.0 data. The available Node runtime uses newer Unicode data for native NFKC. The corpus investigation identified 37 differences involving characters unassigned in the backend's Unicode 15.0 data; matching the folding table is not a claim that those separate normalization versions are identical. No speculative normalization-version workaround was added.

This report records the defects reproduced and changes delivered in this pass. It does not assert that every application defect has been found.
