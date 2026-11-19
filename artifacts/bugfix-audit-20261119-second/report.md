# Second bugfix audit — 2026-11-19

Branch: `fix/app-bugs-excluding-processing-20261119`.
Starting commit for this pass: `34eae170d0a12beea5ae48421fe334b93dda7969`.
Original main baseline: `b7e3aec091faa8896450cbe575cda4ab92544b13`.

This pass implements fifteen additional groups of reproduced defects. It follows the first audit, whose fixes and baseline failure reproductions remain in `../bugfix-audit-20261119/`. No PR is part of this work. Processing and AD Master remain excluded.

**Live acceptance remains incomplete.** This Linux environment cannot run the required Windows `start-multy.bat` scenarios in two real Electron windows or exercise physical audio devices. The room, transfer, audio, and desktop findings below have code changes and automated regression evidence, not a claim that live Windows behavior has been verified. macOS reactivation was exercised in the main-process test fixture, not on a Mac.

## Additional changes and their evidence

| Area | Reproduced defect | Change and proof |
| --- | --- | --- |
| Song metadata | Clearing the artist sent an omitted PATCH field, preserving the old value. | Submit an explicit trimmed string, including empty. Real form regressions cover empty and whitespace-only inputs. |
| Recording preview | Seeking while a take loaded cleared ownership; Pause and close/unmount cleanup then lost the active preview. | Preserve pending-load ownership, queue the seek, and retain generation checks. Tests cover pause after load and cancellation during unmount. |
| Room radio | Manual toggle/station requests discarded rejected promises and omitted an actionable failure notice. | Route rejections through the existing operation-failure channel without changing authoritative room state. Two actual failing regressions became passing. |
| Room library | The unpublished key matched the empty-library key, skipping initial and recovered empty catalogs. | Use a distinct unpublished sentinel. Tests cover initial/recovered empty publication, pending reads, and retired late reads. |
| Desktop room entry | A normal `openRoom` command without an invitation code was consumed without opening the dialog. | Allow the optional code through the existing callback. Immediate, queued, and invitation-code paths are covered. |
| Desktop command lifetime | Commands arriving during renderer crash/reload/destruction were sent to the retired renderer and lost. | Disconnect delivery at the renderer lifecycle boundary and replay queued commands after readiness. Subframe/hash navigation and old-owner events are covered. |
| Audio notifications | Renderer crashes left active notification sockets/reconnect activity behind when a repeated-crash guard prevented reload. | Stop subscriptions on `render-process-gone`; verify resubscription and subsequent destruction cleanup. |
| Main-window reactivation | A new macOS main window inherited the old reveal flag and close approval, remaining hidden or bypassing unsaved-work confirmation. | Reset the two per-window flags on creation. Both outcomes were reproduced in the existing main-process fixture. |
| Native media readiness | Stop during decoder loading published Ready and accepted playback with no decoded audio. | Preserve Loading until the existing worker publishes current-generation audio/EOF. Rewind/cancellation remain unchanged. A blocked-decoder test was RED before the status guard. |
| Package input validation | Encrypted/unsupported ZIP entries and unsupported-version or invalid-UTF-8 archive headers leaked Python exceptions. | Validate entry features and narrowly translate constructor decoding/format failures into `PackageInvalid`. Real malformed archives exercise inspect/read/extract. |
| Export snapshot integrity | Replacing a manual clip after export hashing but before ZIP writing produced a successful yet unimportable package. | Snapshot the selected clip before both checksum calculation and archive writing. A paused-export replacement test imports and verifies the resulting original snapshot bytes. |
| Export cancellation | Cancel during snapshot/writing/validation still published a successful archive and history record. | Cooperative checks before publication, including after ZIP validation. Cancellation cleans this attempt's temporary data; a previously published archive survives. Requests losing to completed publication retain success. |
| Import idempotency | Concurrent requests with one idempotency key started two jobs and leaked a SQLite uniqueness failure. | Use the existing bounded keyed-lock manager around repeat/preflight/start/save. Identical, conflicting, and failed-preflight retry cases are covered. The guarantee is for the normal single backend owning the profile, not distributed coordinators. |
| API integer bounds | Oversized history/job/recording offsets and editor/package revisions reached SQLite and raised OverflowError. | Constrain these manual/query inputs to signed 64-bit values. Five real endpoint regressions also check valid maximum offsets. |
| Export disk accounting | A separate selected clip was omitted from the space check; copying an imported revision could also copy a huge obsolete clip or unexported local/cache files. | Count the selected clip once and select the portable snapshot plus supplements before copying. The real import → smaller manual override → export → import scenario passes. Default full snapshots for migration remain unchanged and have a guard test. |

The pass changes 37 source/test files and adds 59 test cases: 20 renderer/Electron, 38 backend, and 1 native. All fifteen groups include an actual failing regression run before the corresponding correction. Regression-first output and final full-suite output are retained in `logs/` with hashes in `verification.json`.

## Full verification

Tested published source commit: `23f3708715d790dccea4b78d31d1f2f155052308`.

| Check | Result |
| --- | --- |
| Frontend TypeScript, architecture, production build | Passed |
| Complete Vitest run | 1203 tests passed; 172 suites passed and 1 excluded AD Master suite failed during collection |
| Complete Electron/script Node run | 109 passed, 5 platform skips, 0 failures |
| Backend compile, architecture, bootstrap, Ruff lint, Windows-target mypy | Passed |
| Required backend formatting | 9 unchanged baseline files fail formatting |
| Complete backend pytest | 2176 passed, 3 unchanged AD Master failures, 10 skipped |
| Native Release build, warnings as errors | Passed |
| Complete native CTest | 2/3 entries passed; main executable: 509 cases passed, 3 baseline/platform failures |

No tests were removed, skipped by a new filter, weakened, or replaced to obtain these results. Full suites ran sequentially after the relevant source freeze. Native and frontend final suites ran before their source commit; backend ran after its final freeze. The tested source subtrees are recorded in `verification.json`.

## Remaining failures and limits

The remaining failures are previously documented issues from the original main or environment limitations, rather than additional changes to the excluded subsystems:

- The AD Master preparation Vitest suite fails during collection because its `@neo-ui-kit/react` mock omits `setLocale`. The excluded test and store behavior are unchanged; the first audit contains the clean-main reproduction.
- Three backend AD Master assertions in `test_recordings_analysis.py` and `test_studio_master_regressions.py` reproduce on the original main. These files and the related implementation remain byte-identical to the baseline.
- The required Ruff formatting gate still reports nine pre-existing files. The complete list is in the static-check log. Lint and Windows-target type checking pass. Formatting was applied only where this pass already changed a file.
- Two native Unix control-socket cases fail because AF_UNIX stream sockets are denied here; the first report contains the direct EPERM probe and clean-main runs. One unchanged recording test expects device-generation invalidation from a suspension that the existing active-recording guard refuses.
- The prior intermittent native aligner case passed this run. No alignment change was made, and this pass does not claim to remediate that earlier timing-sensitive fixture.

The live-gate status is in `../room-e2e/2026-11-19-app-bugs-second/verification-status.json`. Windows process cleanup, actual device behavior, rendered two-window room/radio/transfer scenarios, and macOS window reactivation remain unverified live. This report does not declare that every possible application defect has been found.

## Scope preservation and review

`protected-scope.json` compares all 151 protected files with original main by SHA-256. They are unchanged. No processing, AI separation/ASR/alignment, DSP, recording algorithm, AD Master, mixing, or tuning threshold was changed.

Mixed-file changes are limited to the manual editor revision input bounds, package-specific use of project storage, renderer preview ownership, and the native Stop readiness guard. The existing full project snapshot is still the default for migration. The general processing job manager and shared processing storage-size helper were not edited.

The renderer, Electron, backend, and native modules were examined in separate work streams. Root reviewed the integrated product diff; the desktop auditor independently reviewed the native state guard; the renderer auditor independently reviewed package publication, cancellation, clip snapshot, and idempotency behavior. Root's follow-up storage review identified the obsolete-clip snapshot peak and required its supported-flow regression before the backend freeze.

Detailed coverage, rejected hypotheses, and test commands are in `frontend-review.md`, `backend-review.md`, `desktop-review.md`, and `native-review.md`. These distinguish code inspection from executable evidence and do not substitute for live acceptance.
