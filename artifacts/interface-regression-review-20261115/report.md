# Regression review, 2026-11-15

Scope: recent interface/theme changes, karaoke introduction/video readiness and console controls, unavailable-analysis handling, silent solo capture admission. Checks ran in the shared working copy; unrelated pending changes were preserved.

## Findings corrected

1. Silent-capture cleanup exceeded the backend function size and complexity limits. Reused the existing stopped-WAV inspection and removed repeated file deletion statements. The architecture rules were retained unchanged.
2. The extended existing cleanup test reproduced a real defect: an unfinished WAV could be deleted when its dry microphone companion was silent. The failing run recorded 1 failure and 11 passes. Cleanup now validates the native WAV header and exact payload/file size before permitting nonempty accompaniment removal. The test still requires the unfinished capture to be preserved.

Existing tests now exercise both empty and silent-microphone cleanup, preservation of active microphone audio and unrecognized files, protection of already registered recordings, sticky microphone activity, and fallback to registration when cleanup is refused. No test function or test file was added.

## Final results

- `check.bat frontend`: 151 Vitest files, 1031 tests passed; Electron and script tests: 105 passed. Types and frontend architecture passed.
- Backend recording scope: 19 passed. This includes empty cleanup, startup recovery, registration, registered-file deletion and interrupted recording deletion recovery. The backend suite was restricted to these paths; unrelated mastering checks were excluded from the final run.
- Backend architecture passed. Scoped Ruff and mypy passed. The two dependency deprecation warnings from Starlette remain.
- Global frontend rule-check still fails. Comparison with commit 887ff07a found no newly introduced rule violations in the files owned by this change set. Existing oversized files and other pending work account for the remaining findings; see the comparison JSON and full rule output.

The initial broad backend runs were interrupted and are not counted as successful verification. The single-file reproduction and final scoped run completed with their recorded exit codes. No new live microphone or room-audio verification was performed during this review.

## Temporary data

Automatic policy review rejected the recursive fixture cleanup with `blocked by policy`. No cleanup was performed and no workaround was attempted. Remaining fixture directories measured 40,764,738 bytes in total:

- `E:\CodexTempinterface-regressions-20261115pytest-data`: 2,717,317 bytes.
- `E:\CodexTempinterface-regressions-20261115pytest-final`: 32,844,413 bytes.
- `E:\CodexTemp\interface-regressions-20261115\pytest-scoped`: 5,203,008 bytes.

Check logs also remain in `E:\CodexTemp\interface-regressions-20261115`; the relevant completed results are copied into this report directory.

## Evidence

- [Frontend final](frontend-final.log)
- [Backend reproduction](backend-reproduce.log)
- [Backend final](backend-scoped-final.log)
- [Backend architecture](backend-architecture-final.log)
- [Frontend rule comparison](frontend-rule-comparison.json)
- [Remaining frontend rules](frontend-rules-final.log)
- [Ruff](ruff.log), [mypy](mypy.log)
