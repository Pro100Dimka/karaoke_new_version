# Architecture

## Direction

```text
API -> use-cases/domain -> ports <- infrastructure
                 ^
                 |
             bootstrap
```

`bootstrap` — единственное место, где concrete infrastructure собирается в application graph. Domain/use-case код не создаёт SQLAlchemy/FastAPI/filesystem/subprocess implementations самостоятельно.

## Persistent boundaries

- API DTO, domain model и ORM model разделены.
- SQLAlchemy разрешён только в `backend/infrastructure`.
- JSON codec централизован в `backend/serialization.py` и feature codecs.
- Subprocess execution централизован в `backend/infrastructure/process_runner.py`.
- Filesystem roots canonicalized и operations проверяют ownership/path boundaries.
- Canonical publication использует temporary/working area + validation + atomic replace/publish.

## Concurrency

- single backend writer lock;
- bounded background executor/queue;
- per-song mutation registry вместо giant global lock;
- revision checks для editor/project mutation;
- explicit cancellation policy per processing stage;
- CPU/RAM/VRAM/disk resource scheduler leases для processing.

## Recovery

Startup выполняет DB migrations/integrity, deterministic recovery journal handling, interrupted-job recovery, recording descriptor reconciliation, library reconciliation и bounded temp cleanup до `Ready/Degraded`.

Recovery journal не считается telemetry: незавершённая transaction либо завершается, либо откатывается по persistent state.

## Processing

`StartProcessing` выполняет idempotency, song-state validation, model/provider preflight и resource claim **до** тяжёлой работы. `PipelineOrchestrator` только оркестрирует маленькие stages. `ProcessingJobManager` владеет lifecycle/progress; `ProjectPublisher` — revision publication.

Concrete AI engine подключается через `AiProvider`. Pipeline зависит от capabilities, а не от Whisper/Demucs/конкретного имени модели.

## Realtime boundary

Python не находится в per-buffer audio path. `AudioService.exe` владеет capture/playback/monitoring/live DSP/mixer/recording PCM/network media/clocks/latency.

## Встроенный локальный AI-провайдер (`local-torch`)

- Провайдер `local-torch` реализует все capabilities (`Separation`, `ASR`, `Alignment`, `Pitch`) и регистрируется в `bootstrap/ai_wiring.py`, если установлен extra `ai` (torch, demucs, openai-whisper, torchcrepe). Явно переданные провайдеры (тесты, embedders) и `AD_VOICE_AI_COMMAND` заменяют встроенный.
- Тяжёлая работа выполняется в **отдельном процессе** `python -m backend.ai_worker <separate|transcribe|align|pitch>`; API-процесс torch не импортирует. Обмен — JSON в UTF-8 по stdout, ошибки — ненулевой код возврата (`AiProviderFailed`).
- Модели описаны в `backend/ai/catalog.py` (id, версия, размер, sha256, URL): HTDemucs (разделение) и Whisper base (распознавание и тайминги слов, uk/ru/en). При старте они объявляются в реестре моделей (`declare_model_catalog`), появляются в Settings и скачиваются штатным `DownloadModel` с проверкой размера и контрольной суммы; воркер читает опубликованный файл `<models>/<id>/<version>/model.bin`. Preflight `MissingRequiredModels` возвращается до тяжёлой обработки.
- Высота тона считается CREPE (`tiny` на CPU, `full` на CUDA), шаг 10 мс; выравнивание — Whisper с подсказкой текста и сопоставлением слов (`difflib`), пропущенные слова интерполируются.
- Метаданные импорта: теги файла имеют приоритет, недостающие artist/title берутся из имени `Artist - Title` (`songs/filename_metadata.py`), происхождение записывается как `Filename`.
