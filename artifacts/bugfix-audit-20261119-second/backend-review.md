# Second backend audit — frozen implementation report

Date: 2026-11-19

Repository: `karaoke_new_version`

Branch: `fix/app-bugs-excluding-processing-20261119`

Follow-up baseline: `34eae170d0a12beea5ae48421fe334b93dda7969`

Scope: continue the user's request to find and repair additional application bugs after the first pass, without changing song processing, AI, ASR, separation, alignment, pitch, DSP, or AD Master/studio. No PR. Root owns the full verification gates, commits, and publication.

## Freeze status

All backend source and tests are frozen. This agent made no commit or push. No processing, AI, ASR, alignment, pitch, DSP, AD Master/studio source or configuration was edited. This document was written after the freeze without source/test changes or additional tests.

The root agent's full backend verification was running on the frozen source when this report was prepared. Its final results should be recorded alongside this report; the focused results below do not replace that gate.

## Implemented changes and reproduction evidence

| Area | Confirmed defect | Implemented change | Actual RED evidence |
| --- | --- | --- | --- |
| ZIP input validation | Encrypted entries, patched data, unsupported compression, unsupported extraction versions, and malformed UTF-8 filenames could escape as Python exceptions. | Reject unsupported entry flags/compression explicitly. Catch only `UnicodeDecodeError` and `NotImplementedError` when opening an input ZIP. Return `PackageInvalid`. | `second-backend-zip-red.log`: **12 failed, 35 passed**. `second-backend-zip-constructor-red.log`: **5 failed, 48 passed**. |
| Export consistency | Replacing a clip manually between export hashing and ZIP construction produced a successful export that another library rejected because its checksum was wrong. | Copy the selected clip into the export workspace before hashing and archive construction. | `second-backend-export-clip-red.log`: **1 failed**, with `Package artifact checksum failed` for `media/clip.mp4`. |
| Export cancellation | Cancellation after snapshotting, during ZIP streaming, or during final archive validation was ignored. | Pass the existing job cancellation callback into package export and ZIP streaming; check again immediately before atomic destination replacement. Preserve success after publication. | `second-backend-export-cancel-red.log`: **2 failed, 1 passed**. `second-backend-export-validation-red.log`: **1 failed, 3 passed**. |
| Import idempotency | Overlapping requests with one idempotency key started two jobs, then one request failed on the SQLite unique constraint. Different input under the same key also escaped the intended conflict check. | Use the existing `KeyedLockManager` around replay detection, preflight, submission, and key persistence. Hashing stays outside the critical section. | `second-backend-import-idempotency-red.log`: **2 failed**. |
| API integer bounds | Oversized offsets in `/history`, `/jobs`, `/recordings`, and oversized revisions in package export/editor save reached SQLite and raised `OverflowError`. | Apply signed 64-bit upper bounds to the relevant API fields. The largest representable offset remains accepted. | `second-backend-api-bounds-red.log`: **5 failed**. |
| Export disk accounting and snapshot selection | Preflight omitted the selected local clip. A smaller replacement could also trigger copying of a large obsolete archived clip before overwriting it. | Count the selected clip once, replacing any portable clip already counted. Package export requests a portable snapshot whose final source paths are selected before copying. Default full snapshots remain unchanged for migration. | `second-backend-export-preflight-red.log`: **3 failed, 1 passed**. `second-backend-export-snapshot-size-red.log`: **1 failed**, proving the real import → smaller manual override → re-export path copied the obsolete clip. |

**38 new test cases** cover these changes and their preservation guards.

All log names in this report refer to files under `/workspace/scratch/726a7fe1e251/` at preparation time. The root agent can copy them into the git-backed audit artifact directory.

## Final focused and static verification

| Check | Result | Evidence |
| --- | --- | --- |
| Focused package/snapshot/migration tests on final frozen source | **48 passed**, 2 existing deprecation warnings; 66.57 seconds | `second-backend-snapshot-final.log` |
| Broader focused set before final portable-snapshot refinement | **122 passed**, 2 existing deprecation warnings; 77.23 seconds | `second-backend-focused-final.log` |
| Mypy using repository-prescribed platform target | `--platform win32`: **10 changed production source files, no issues** | `second-backend-mypy-win32.log` |
| Ruff | Passed | `second-backend-ruff.log` |
| Formatting | **16 changed/new files already formatted** | `second-backend-format.log` |
| Architecture | Passed; existing size warnings only | `second-backend-architecture.log` |
| Diff whitespace check | `git diff --check -- python`: passed | Tool output, exit code 0 |

The 48-test final run covered:

- `tests/test_package_export_preflight.py`
- `tests/test_package_export_cancellation.py`
- `tests/test_packages_e2e.py`
- `tests/test_package_migration.py`
- `tests/test_project_migration_recovery.py`

The earlier 122-test run covered package security, end-to-end export/import, cancellation, preflight, idempotency, API bounds, library archives, identity collisions, metadata validation, migration, editor revisions, and system API. It is supplemental evidence rather than a substitute for the final full backend run.

The initial default-Linux mypy invocation reported the existing 15 Windows-symbol errors in three unchanged infrastructure files: `windows_child_job.py`, `instance_lock.py`, and `process_runner.py`. The repository's prescribed `--platform win32` invocation passed. The initial output remains in `second-backend-mypy.log`.

Additional focused intermediate logs:

- `second-backend-zip-green.log`: initial ZIP entry checks, 47 passed.
- `second-backend-export-clip-green.log`: clip-focused end-to-end checks, 4 passed.
- `second-backend-export-cancel-green.log`: cancellation and ZIP checks at that stage, 51 passed.
- `second-backend-import-idempotency-green.log`: overlapping same/conflicting input, 2 passed.
- `second-backend-zip-idempotency-green.log`: ZIP constructor cases plus idempotency retry guard, 56 passed.
- `second-backend-api-bounds-green.log`: API overflow cases and largest valid offsets, 5 passed.
- `second-backend-export-preflight-green.log`: preflight/cancellation checks at that stage, 9 passed.

Intermediate logs establish the RED→GREEN sequence. Final-source confidence comes from the final focused snapshot run, latest static checks, and the root agent's full backend gate.

## Preservation guarantees exercised

- Cancellation before publication leaves no new output, additional export history, or ZIP temporary file.
- Cancellation while replacing an existing export preserves its exact bytes and previous history. The song title changes before the attempted replacement, so this test would detect publication of a new archive.
- Cancellation after publication retains the successful result and history.
- Failed import preflight creates neither an import job nor an idempotency record; a corrected retry and replay succeed.
- Concurrent identical requests return one job. Conflicting input under the same key yields `IdempotencyConflict`, with one job total.
- A real exported/imported project with a large archived clip can receive a smaller manual override, re-export within the selected-file budget, and import successfully again.
- Portable snapshots omit local-only, temporary, and unlisted files. Default snapshots still include those files, preserving migration behavior.
- The existing `ProjectStorage.portable_revision_size` helper also used by processing was not changed. Package-specific selected-clip accounting is confined to package preflight.

## Idempotency boundary

The keyed lock protects concurrent requests handled by the application's single `StartPackageImport` coordinator. Production bootstrap constructs that coordinator only after acquiring the profile's `BackendInstanceLock`; its OS guard prevents another normal backend from owning the same library concurrently.

This is not a distributed or arbitrary multi-coordinator idempotency guarantee. Lock entries are released through the existing keyed-lock owner/waiter cleanup. Hashing is outside the critical section, while replay detection, preflight, submission, and idempotency persistence stay within it.

## Reviewed coverage and rejected hypotheses

| Reviewed boundary | Modules/scenarios inspected | Outcome |
| --- | --- | --- |
| Package lifecycle | `background.py`, `export_package.py`, `preflight.py`, `inspect_package.py`, `codec.py`, `security.py`, ZIP adapter; publication/import supplementary clip paths | Confirmed defects above; existing identity collision checks retained. |
| Library archives | `library_archive.py`; storage snapshot, row selection, restore validation and rollback paths in `library_storage.py` | No additional validated defect in this pass. Existing round-trip, invalid archive, and rollback tests passed in the 122-test run. |
| Project storage | `local_projects.py`, project ports/domain, keyed locks; publisher artifact selection and migration snapshot call sites | Package-only portable selection introduced. Processing size helper and default migration snapshot behavior preserved. |
| Editor persistence | `save_document.py`, `reset_document.py`, atomic text writing and revision cloning | Oversized expected revision reproduced and bounded. Hard-link corruption hypothesis rejected: editor text writes replace files instead of changing the shared inode. Other failure-cleanup hypotheses were not promoted to fixes without reproduction. |
| Deletion/recovery | `delete_song.py`, transaction recovery, startup recovery, library/song reconciliation | Reviewed quarantine/metadata sequencing and reconciliation guards. No new validated change; processing-related startup reconciliation left untouched. |
| Account/social state | Accounts, friends, inbox, social socket/hub; relevant SQLite account methods | Reviewed stale account snapshots, device ownership checks, avatar version preservation, presence departure and notification delivery. No new validated change. |
| Settings | Update/settings persistence boundary | Settings update is processing configuration; deliberately left unchanged. |
| API boundaries | Package routes, manual editor DTOs/routes, history/job/recording pagination | Five actual overflow paths reproduced; bounded at API entry. |
| Duplicate clip artifact hypothesis | Normal project publisher and package import publication | Normal publisher creates audio/peaks/lyrics artifacts; package import publishes the supplementary clip without adding it to `ProjectManifest.artifacts`. No speculative archive-format change made for hand-crafted manifests. |

This was a broad, evidence-driven backend pass, not proof that every remaining backend path is bug-free. Room audio and processing/mastering internals were outside the authorized edit scope. Read-only inspection of interfaces and publication call sites did not change those excluded implementations.

## Changed files

Production, 10 files:

- `python/backend/api/package_routes.py`
- `python/backend/api/recording_routes.py`
- `python/backend/api/song_dto.py`
- `python/backend/api/system_routes.py`
- `python/backend/infrastructure/local_projects.py`
- `python/backend/infrastructure/zip_archive.py`
- `python/backend/packages/background.py`
- `python/backend/packages/export_package.py`
- `python/backend/packages/preflight.py`
- `python/backend/projects/ports.py`

Tests, 6 files:

- `python/tests/test_package_security.py`
- `python/tests/test_packages_e2e.py`
- `python/tests/test_api_integer_bounds.py` — new
- `python/tests/test_package_export_cancellation.py` — new
- `python/tests/test_package_export_preflight.py` — new
- `python/tests/test_package_import_idempotency.py` — new

Mixed-file changes are limited to generic pagination bounds, manual editor revision bounds, and package export snapshots. No processing DTO or job-manager behavior changed.

## Remaining verification boundaries

The required Windows `start-multy.bat` project-transfer scenario in two real Electron windows was not run in this Linux environment. Backend tests provide implementation evidence only; they do not satisfy that live project-transfer gate. Do not describe project-transfer work as fully verified from these automated checks.

The root agent's final full backend result and commit/publication hashes are intentionally not asserted here because those actions were still in progress when this frozen implementation report was prepared.
