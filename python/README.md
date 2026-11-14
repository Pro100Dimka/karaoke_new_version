# A&D Voice Python Backend

Локальный application backend A&D Voice. Продуктовые сценарии — в `docs/greenfield-spec.md`, правила — в `docs/architecture_rules.md`, `docs/code_rules.md`, `docs/test_rules.md` и корневом `AGENTS.md`.

## Граница ответственности

Python владеет persistent application state, библиотекой песен, project revisions, offline processing/AI orchestration, lyrics/editor persistence, packages, recording registry, offline analysis, models, storage, history, recovery, diagnostics и room control.

Python **не** является realtime audio engine: capture/playback/monitoring/mixer/DSP/clocks/network audio/latency остаются в `AudioService.exe`.

## Удалённая обработка через Oracle

В настройках обработки выберите **Удалённый ПК через Oracle**. В **Ключи ENV**
укажите `AD_VOICE_PROCESSING_TOKEN`, полученный от владельца обработчика.
Исходная песня отправляется одним заданием через существующий HTTPS-сервер Oracle.
ПК владельца выполняет полный локальный конвейер и возвращает одним пакетом готовые
дорожки, текст и ноты. Между этапами передаются только небольшие сообщения прогресса.
Публикация новой версии и защита ручных правок остаются в библиотеке клиента.
Обязательные модели на ПК клиента
для этого режима не нужны. Старый сохранённый выбор Kaggle переводится на Oracle.

Владелец запускает `start-processing-worker.bat` из корня проекта. Служебные данные,
сеансы и кэши обработчика находятся в `E:\ADVoiceData\ProcessingWorker`, модели
используются из существующего каталога на E:. Без диска E: обработчик не запускается.
Закрытие обычного приложения не останавливает отдельно запущенный обработчик.
На компьютере владельца задача Windows **AD Voice Processing Worker** запускает
его при входе пользователя. Для штатной остановки используйте
`start-processing-worker.bat --stop`, для ручного запуска снова запустите batch-файл.
Журнал `E:\ADVoiceData\ProcessingWorker\worker.log` ограничен двумя файлами по 4 MiB.
Настройки владельца находятся в игнорируемом файле
`local-secrets/env/processing-worker.env`; ключ обработчика отличается от клиентского
ключа и не передаётся пользователям. ПК делает только исходящие HTTPS-запросы.

На Oracle работает отдельная служба `ad-voice-processing.service`, её очередь
сохраняется в SQLite. Она использует существующие вычислительные ресурсы и диск,
не создаёт облачные ресурсы и не подключает платные вычислители. Установлены лимиты:

- 100 GB в месяц для исходящих файлов и консервативного учёта служебных ответов;
- 256 MiB на одну передачу, 5 GiB зарезервированного места, до 16 активных заданий;
- 24 часа хранения файлов на сервере; клиент ожидает результат до двух часов;
- одно задание одновременно на ПК с обычной локальной политикой ресурсов;
- временная библиотека полного задания удаляется после передачи результата;
- для частичного пересчёта используются прежние сеансы с лимитом 6 GiB и сроком 24 часа.

При превышении лимита передача отклоняется. Лимит обработки существенно ниже
бесплатных 10 TB исходящего трафика Oracle, но не учитывает расход других служб
аккаунта. Изменение тарифа или ресурсов Oracle этим режимом не выполняется.
Счётчик обработки хранится в `data/queue.sqlite3`, его нельзя удалять или обнулять
в текущем месяце. Для общей оценки расходов используйте биллинг Oracle.

Серверные файлы: `scripts/processing-server.py`, `scripts/processing-server.service`
и `scripts/processing-proxy.conf`. `scripts/deploy-processing-server.sh` устанавливает
их из закрытого временного каталога `/tmp/ad-voice-processing-YYYYMMDD-HHMMSS`
вместе с `server.env`, содержащим два разных ключа и
`AD_VOICE_PROCESSING_DATA=/opt/karaoke-processing-server/data`.
Служба комнат при этом не перезапускается. После успешного развёртывания удалите
временный `server.env`, сохранив конфигурацию и копии для отката отдельно.

## Локальное окружение

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

Для работы всего приложения из корня репозитория используйте `start.bat` (одно окно) или `start.bat dev` (renderer с Vite hot reload). Electron управляет backend/audio process lifecycle. Комнатные live-проверки выполняются отдельно через `start-multy.bat` по `AGENTS.md`.

Самостоятельный запуск только backend из `python`:

```bash
python -m backend.main
```

При самостоятельном запуске по умолчанию backend слушает `127.0.0.1:8765` и использует `./data`. При запуске из Electron data root выбирается сохранённым storage root, затем `AD_VOICE_DATA`, иначе `userData/backend-data`; порт обычно назначается динамически (`AD_VOICE_PORT=0`), фактический endpoint сообщает backend.

Общий Room Server собирает логи запущенных приложений и собственные сообщения в
`$AD_VOICE_ROOM_SERVER_DATA/logs/program.jsonl`. На Oracle это
`/opt/karaoke-room-server/data/logs/program.jsonl`: один JSON-объект на строку с
временем, `clientId`, источником, уровнем и сообщением. Файл доступен только на
сервере; для диагностики читать его по SSH. При достижении 128 МиБ сохраняются
последние примерно 64 МиБ записей.

Переменные окружения:

- `AD_VOICE_DATA` — managed storage root;
- `AD_VOICE_PORT` — API port;
- `AD_VOICE_LOG_LEVEL` — log level;
- `AD_VOICE_AI_COMMAND` — optional local AI-provider command;
- `AD_VOICE_AI_VERSION` — version external provider adapter.
- `AD_VOICE_AUDD_TOKEN` — optional AudD token for audio-fingerprint song recognition during import;
- `AD_VOICE_YOUTUBE_API_KEY` — optional YouTube Data API key for finding the recognized song's clip.

## Проверка

Основной способ из корня репозитория:

```bat
check.bat backend
check.bat backend tests/test_letter_alignment.py
check.bat all
```

Первая команда запускает полный backend-набор, вторая — только промежуточный целевой тест, третья — полные наборы всех трёх подсистем. Выходной код и все применимые live-gates сохраняются. Прямой эквивалент полного backend-набора из `python`:

```bash
python scripts/run_checks.py --require-dev-tools
```

Команда выполняет:

1. compileall для `backend`, `tests`, `scripts`;
2. architecture/static gates;
3. bootstrap composition smoke;
4. обязательные Ruff formatter/lint и mypy;
5. полный pytest suite.

Отсутствие Ruff или mypy в полном наборе является ошибкой. GitHub CI устанавливает `.[dev]` и запускает строгий режим. `TEST_RESULTS.md` хранит исторический прогон, не статус текущего рабочего дерева.

## Обработка существующего проекта

Полный `Reprocess`, пересчёт только melody и UI-действие `Уточнить слова и ноты` — разные операции. Последнее использует существующие stems, текущий текст, язык и phrase hints, затем публикует новую ревизию. Ручные правки не заменяются молча: при конфликте UI предлагает подтверждаемый возврат к AI baseline с сохранением истории. Детали поиска текста, повторов, CTC-ядер и acoustic endings — в `docs/greenfield-spec.md`, §§75–85.

Клип загружается параллельно audio pipeline после recognition, с общей отменой. Волна для импортируемой/обрабатываемой песни читается из managed source через `GET /songs/{id}/waveform`; готовый instrumental читает Electron. Renderer audio не декодирует.

## Основные каталоги

- `backend/api` — только HTTP DTO/routing/mapping;
- `backend/bootstrap` — composition root и lifecycle;
- `backend/songs`, `projects`, `processing`, `lyrics`, `editor`, `packages`, `recordings`, `analysis`, `models`, `room` — предметные capabilities/use-cases;
- `backend/infrastructure` — SQLite, filesystem, subprocess, FFmpeg, HTTP, ZIP, clocks, IDs;
- `backend/recovery`, `storage`, `settings`, `history`, `diagnostics`, `capabilities` — системные capabilities;
- `tests` — unit/integration/E2E/failure/recovery/security/architecture tests;
- `docs` — исходная LOCKED specification и правила разработки.

Подробнее: `ARCHITECTURE.md`, `docs/RULES_COMPLIANCE.md`, `docs/SPEC_IMPLEMENTATION.md`.
