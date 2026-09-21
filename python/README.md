# A&D Voice Python Backend

Локальный application backend A&D Voice, реализованный по `docs/greenfield-spec.md` и правилам из `docs/описание.txt`, `docs/архитектура.txt`, `docs/код.txt`, `docs/тесты.txt`.

## Граница ответственности

Python владеет persistent application state, библиотекой песен, project revisions, offline processing/AI orchestration, lyrics/editor persistence, packages, recording registry, offline analysis, models, storage, history, recovery, diagnostics и room control.

Python **не** является realtime audio engine: capture/playback/monitoring/mixer/DSP/clocks/network audio/latency остаются в `AudioService.exe`.

## Runtime

- Python 3.12–3.13
- FastAPI
- SQLAlchemy + SQLite
- FFmpeg/FFprobe в `PATH`
- AI engine подключается через `AiProvider`; конкретная модель не зашита в application architecture

## Установка

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
python -m pip install -e ".[dev]"
```

FFmpeg/FFprobe должны быть доступны через `PATH`.

## Запуск

```bash
python -m backend.main
```

По умолчанию backend слушает `127.0.0.1:8765` и использует `./data`.

Переменные окружения:

- `AD_VOICE_DATA` — managed storage root;
- `AD_VOICE_PORT` — API port;
- `AD_VOICE_LOG_LEVEL` — log level;
- `AD_VOICE_AI_COMMAND` — optional local AI-provider command;
- `AD_VOICE_AI_VERSION` — version external provider adapter.

## Проверка

```bash
python scripts/run_checks.py
```

Команда выполняет:

1. compileall для `backend`, `tests`, `scripts`;
2. architecture/static gates;
3. bootstrap composition smoke;
4. Ruff formatter/lint и mypy, если dev-tools установлены;
5. полный pytest suite.

Для release/CI используется строгий режим:

```bash
python scripts/run_checks.py --require-dev-tools
```

В нём отсутствие Ruff или mypy является ошибкой. GitHub CI устанавливает `.[dev]` и запускает этот режим. Последний зафиксированный локальный прогон находится в `TEST_RESULTS.md`.

## Основные каталоги

- `backend/api` — только HTTP DTO/routing/mapping;
- `backend/bootstrap` — composition root и lifecycle;
- `backend/songs`, `projects`, `processing`, `lyrics`, `editor`, `packages`, `recordings`, `analysis`, `models`, `room` — предметные capabilities/use-cases;
- `backend/infrastructure` — SQLite, filesystem, subprocess, FFmpeg, HTTP, ZIP, clocks, IDs;
- `backend/recovery`, `storage`, `settings`, `history`, `diagnostics`, `capabilities` — системные capabilities;
- `tests` — unit/integration/E2E/failure/recovery/security/architecture tests;
- `docs` — исходная LOCKED specification и правила разработки.

Подробнее: `ARCHITECTURE.md`, `docs/RULES_COMPLIANCE.md`, `docs/SPEC_IMPLEMENTATION.md`.
