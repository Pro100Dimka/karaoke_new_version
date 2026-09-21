# Rules compliance

Исходные правила сохранены без замены в:

- `описание.txt`
- `архитектура.txt`
- `код.txt`
- `тесты.txt`

Ниже — не копия правил, а проверяемая карта реализации.

| Требование | Реализация / gate |
|---|---|
| Domain-first modules | `backend/<capability>` + required-directory architecture gate |
| Thin API | routers содержат validation/mapping/call use-case; FastAPI запрещён вне `backend/api` |
| Domain != API DTO != ORM | dataclasses/enum domain, Pydantic API DTO, ORM только infrastructure |
| Dependency direction | forbidden imports + import-cycle gate |
| No God Service | generic `*Service` classes запрещены gate; file/function/complexity limits |
| Production file <= 500 lines | automated architecture gate |
| Function <= 60 lines / bounded complexity | automated AST gate |
| Type hints | automated public/function annotation gate |
| No `Any` convenience | разрешён только serialization boundary |
| No TODO/type-ignore/local imports/dynamic execution | automated gates |
| State enums | `StrEnum` domain states; tests transitions |
| Central subprocess boundary | только `infrastructure/process_runner.py` |
| Central JSON library boundary | только `backend/serialization.py` напрямую импортирует `json` |
| SQLAlchemy isolation | automated gate: только `backend/infrastructure` |
| FastAPI isolation | automated gate: только `backend/api` |
| Bounded background work | `BoundedJobExecutor`; queue-full/Stopping tests |
| Explicit timeouts/cancellation | `ProcessRunner`, provider retry/cancel, processing policies/tests |
| Resource bounded processing | `ResourceBudget` + `ProcessingResourceScheduler` CPU/RAM/VRAM/disk leases |
| Single writer | `BackendInstanceLock`; restart/second-writer tests |
| Atomic publication | projects/models/packages/file writes through staged publication/atomic replace |
| Recovery | recovery journal + deterministic startup rollback/finish tests |
| Project revisions | manifest + fingerprint + optimistic editor revisions + migration tests |
| Package security | traversal/absolute/drive/symlink/file count/size/ratio/corrupt/checksum/version tests |
| Recording recovery | descriptor reconciliation startup test |
| Migration coverage | DB/settings/project compatibility+migration tests |
| Cache safety | versioned key + corrupt cache discard test |
| Structured bounded logs | JSON formatter + rotating handler test |
| No sleep-based test synchronization | automated test-source gate; events/fakes used instead |
| Repository/provider contracts | reusable SQL repository, AI provider and lyrics provider contract suites |
| Fault injection | atomic rename, DB commit, recovery/cleanup idempotency tests |
| Platform/path coverage | Windows path semantics + Unicode filename + locale tests |
| CI acceptance | Windows fast/integration lanes + Linux release lane; release requires Ruff + mypy |
| Dead code/contracts | architecture gate rejects dead production modules and duplicate Protocol/API schema declarations |
| Failure tests | CUDA OOM, timeout, queue full, corrupt package/project/cache, interrupted transactions |
| Realtime boundary | no capture/playback/monitoring/live mixer/DSP implementation in Python |
| Full replacement | architecture gate rejects legacy/old/v2/v3/final implementation filenames |

`python scripts/run_checks.py` is the local acceptance gate. `python scripts/run_checks.py --require-dev-tools` is the release/CI gate and fails if Ruff or mypy is unavailable.
