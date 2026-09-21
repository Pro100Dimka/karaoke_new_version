# Test Results

Final verification date: 2026-09-18

## Local acceptance verification

The final source tree was verified from a clean cache-free state with:

```text
compileall: passed
architecture/static gate: passed
bootstrap smoke: passed
pytest: 137 passed, 1 skipped
```

The one skipped test is explicitly marked Windows-only on Linux. The repository CI has a
`windows-latest` integration lane that runs `integration or windows` tests.

The pytest suite was executed in three deterministic groups to avoid host command-runtime
limits. Results were:

```text
74 passed
25 passed, 1 skipped
38 passed
---------------------
137 passed, 1 skipped
```

## Acceptance gate

Normal developer command:

```bash
python scripts/run_checks.py
```

Release/CI command:

```bash
python scripts/run_checks.py --require-dev-tools
```

The gate performs:

1. `compileall` for `backend`, `tests`, and `scripts`;
2. architecture/static gates (`scripts/architecture_check.py`);
3. bootstrap composition smoke (`python -m scripts.bootstrap_smoke`);
4. Ruff formatter + Ruff lint when Ruff is installed;
5. mypy when mypy is installed;
6. the full pytest suite.

With `--require-dev-tools`, missing Ruff or mypy is a hard failure. GitHub CI installs
`.[dev]` and uses this strict mode, so release CI cannot silently skip either tool.

## Architecture/static gates

The self-contained architecture gate verifies, among other rules:

- required domain-first layout;
- no FastAPI outside `backend/api`;
- no SQLAlchemy outside `backend/infrastructure`;
- no direct JSON access outside the serialization boundary;
- no subprocess use outside `process_runner.py`;
- no circular imports;
- no generic `*Service` classes / banned god-service names;
- production files <= 500 lines;
- functions <= 60 lines and bounded complexity proxy;
- complete function annotations;
- no convenience `Any` outside serialization;
- no TODO/FIXME/XXX, local imports, dynamic execution/import, or mutable module globals;
- no semicolon-separated production statements;
- no legacy/old/v2/v3/final replacement filenames;
- no sleep-based synchronization in tests;
- no dead production modules;
- no duplicate Protocol/API schema declarations;
- constructor dependency-count warnings above the configured responsibility threshold.

## Covered behavior

The suite includes unit, contract, integration, E2E, security, recovery, migration and
failure-path coverage for:

- lifecycle, health, readiness, version, capabilities and diagnostics;
- song import/search/update/delete/idempotency;
- repository contracts and AI/lyrics provider contracts;
- processing, model preflight, bounded CPU/RAM/VRAM/disk resources, cancellation and failure;
- melody-only reprocessing using validated existing artifacts;
- project revisions, editor conflicts/reset, validation and migration;
- package import/export, checksum/security/version/conflict/disk-preflight behavior;
- recording target/registration/recovery and offline analysis/staleness;
- DB/settings/project migrations and migration failure rollback;
- startup recovery and transaction rollback/finish decisions;
- failed atomic rename, DB commit failure and cleanup/recovery idempotency;
- bounded job queue, process timeout/cancellation and path boundaries;
- Windows path semantics, Unicode filenames and `Auto/Ukrainian/Russian/English` locales;
- FFmpeg minimal-media contract and serialization round trips;
- room authority, readiness, authoritative snapshot and host-disconnect policy;
- model checksum/update/download preflight;
- cache corruption/versioning/deletion safety;
- reproducibility metadata and query-count/N+1 protection;
- structured bounded logging;
- architecture boundaries themselves.

## Local tooling note

Ruff and mypy are declared in `.[dev]` and are mandatory in CI via
`--require-dev-tools`. The isolated build container used for this chat does not have those
executables installed and cannot download packages from the network, so this local report
does not falsely claim that their binaries were executed here. The self-contained compile,
architecture, bootstrap and pytest gates above were executed successfully.
