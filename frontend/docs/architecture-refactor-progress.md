# Упрощение архитектуры — 2026-10-26

Актуальный результат относительно `6bf3c2d9`. Разделы ниже — исторические отчёты:
их требования к статическим Provider и запрету любых импортов клиентов из features
заменены описанными здесь правилами. Весь проект пока нельзя считать завершённым
архитектурным рефакторингом; обязательная проверка комнат в этой работе не выполнена.

После код-ревью 2026-10-26 исправлены четыре замечания: общий опрос заданий теперь
выполняет один запрос за раз и объединяет ожидающие обновления; подписки на задания
и `localProcessing` разделены; подмены редактора и синхронизатора используют
`audioClient.snapshot`; существующие сценарии очереди согласованы с общим опросом.
Для этих исправлений повторно прошли TypeScript, проверка архитектурных импортов
и `git diff --check`. Автоматические тесты не запускались. Ручная проверка и статистика
сокращения ниже относятся к состоянию до этих исправлений; они не подтверждают новое поведение.

## Что удалено и упрощено

- Удалены неиспользуемые `settingsNEW`, старый WebGL-рендерер света, `stageRig`,
  `performanceAnalysis`, отключённый `PassiveLatencyEstimator` и его политика.
  Действующие настройки, Canvas/worker-освещение и явная акустическая диагностика сохранены.
- Удалены `LibraryProvider`, `EditorProvider`, `KaraokeProvider` и неиспользуемые порты:
  они только передавали неизменяемые клиенты. Features вызывают публичные клиенты напрямую.
  Контексты разделяемого состояния и координаторы с отменой/восстановлением остаются.
- Список заданий и признак локальной обработки имеют один источник в `AppProvider`.
  Окно очереди хранит только порядок и скрытые карточки, без второго опроса backend.
  Обновление идёт по событиям с резервным опросом; открытие очереди использует текущий снимок.
- Частый запрос позиции воспроизведения получает `GetPlaybackSnapshot` вместо полной
  диагностики. Поля берутся из той же реализации; полная диагностика сохранена.
  Удалены неиспользуемые методы записи и второй флаг записи в `audioClient`.
- В Python простые операции чтения настроек, выделения пути записи, очистки и хеширования
  используют функции. Прокладка `ListModels` удалена: маршрут читает модели в транзакции.
  Жизненный цикл фоновых заданий, публикация проектов и восстановление не заменены заглушками.
- Проверка импортов разрешает публичные service API, но запрещает внутренние service-модули
  в features и обратные зависимости. Пустой baseline удалён. Две почти одинаковые инструкции
  объединены в `frontend/rules/architecture.md`; аппаратные ограничения сохранены.
- 77 файлов генерируемой `AudioService/build-latency` исключены из Git; локальная сборка сохранена.

Чистое сокращение production/tooling: **2018 строк**. Ещё 215 строк сокращено в существующих
тестовых файлах при удалении мёртвых реализаций и обновлении импортов/фикстур. Сгенерированные
файлы и документация в число удалённых строк production-кода не включены.

## Проверка текущего состояния

| Проверка | Результат |
| --- | --- |
| TypeScript, включая существующие тестовые исходники | Успешно |
| Vite, компиляция Electron, сборка AudioService Release | Успешно; Vite сохраняет предупреждение о крупном JS chunk |
| Ruff и mypy backend | Успешно, mypy: 263 файла |
| Frontend architecture checker, `git diff --check` | Успешно |
| Python architecture checker | 6 прежних нарушений в 5 неизменённых файлах: размер файлов/функций и локальный импорт |
| Автоматические тесты | Не запускались и не добавлялись по правилу пользователя |
| Настоящее Electron-приложение, изолированные данные на E: | Библиотека, очередь, настройки и список моделей; запуск песни, пауза, +10 секунд, продолжение, остановка, завершение по EOF и сохранение записи; редактор, загрузка 379 нот, предпрослушивание/пауза |

В локальной диагностике ответ позиции без истории высоты голоса занимал 294 байта
(12 полей), полный отчёт — 10599 байт (351 поле). Это измерение объёма ответа,
а не доказательство снижения физической аудиозадержки или общей нагрузки CPU.
Никто не пел: качество вокального анализа и акустический результат не проверены.

Материалы ручной проверки и логи: `E:\CodexTemp\architecture-20261026\evidence.json`.
Снимки: `karaoke-playing.png`, `performance-finished.png`, `editor-notes.png`.
Проверочное приложение закрыто штатно, его процессы завершились. Автоматическая проверка
разрешений заблокировала очистку (`blocked by policy`): изолированные данные и профиль на E:
сохранены, как и созданный для них junction `AppData/Roaming/ADVoice Architecture Check`.
Повторной попытки очистки другим инструментом не было.

## Что остаётся

Python relay и native relay нельзя удалить как заведомо мёртвый код: локальный сервер
использует Python-вариант при отсутствии native binary. Перестройка этого пути требует
отдельной миграции запуска и живой проверки комнат. Серверная архитектура комнат не менялась,
но общие клиенты и запрос позиции используются и комнатами: их регрессии здесь не проверены.

Координатор записи, её очередь переходов и single-flight завершения сохранены: они защищают
от поздних результатов, повторного завершения и остановки новой сессии старой операцией.
Их механическое объединение не уменьшает необходимую сложность. Остаются большие модули
и описанные выше нарушения Python-проверки; этот этап не означает «всё лишнее удалено».

---

# Architecture refactor: room session boundary (phase 1)

Date: 2026-10-07. This is a progress report, not a claim that the requested architecture refactor is complete.

## BEFORE architecture

```text
RoomModal / FriendsList / SocialAlerts / RoomDock
  -> roomClient + audioClient (+ other concrete clients)
  -> AppContext React room state
RoomSync.tsx -> Room Server + AudioService + Python + Electron + navigation
```

- `RoomSync.tsx` still has over 650 lines and owns polling, transfer, voice reconciliation, navigation, recovery, and hidden state in refs.
- At the start of this phase, features had 62 direct static imports of the four concrete room/audio/Python/desktop clients. `useKaraokeSession.ts` has over 500 lines and also contains application operations.
- Room Server is authoritative for playback state and musical timeline. React state and refs are local projections; treating a server `playing` snapshot as proof that the local project is ready would break late join.
- `AudioService` exposes mutable `session()`, `realtime()`, `media()`, `recording()`, and `network()` engines in its public header. The current production callers do not use these accessors; native tests do. Its `handle()` already routes through bounded handlers for service, mixer, playback, recording, signal, preview, radio, and network commands, so replacing the router mechanically would add little value.

## Root causes

The entry and exit operations were duplicated across UI components and coupled to concrete infrastructure clients. `AppContext` owned an independent room snapshot while `RoomSync` also kept `roomRef`. No automated import rule guarded the frontend dependency direction. These are separate from Room Server authority: the missing owner is for this window's participation and in-flight operations.

## Changes made in this phase

```text
UI intent -> RoomSessionController -> RoomClient / AudioServiceClient ports
                    |
                    +-> local session state -> useSyncExternalStore -> UI
AppProvider -> concrete client composition
```

- Added `RoomSessionController` with a discriminated local state: `disconnected`, `joining`, `joined`, `recovering`, `leaving`, `failed`. Room Server snapshots remain authoritative. The controller owns create/join, voice registration, leave/close, deduplication, cancellation, and compensation of a partial join.
- `AppProvider` now exposes the controller and subscribes to its room snapshot. The room modal, friend invitation flows, room dock exit, and app exit send commands to it. The old `enterRoom` helper was removed.
- Moved the relay mix participant identifier from a feature module to a shared contract, removing an infrastructure-to-feature reverse import.
- Added an architecture checker to `npm test`. It rejects React/UI/concrete infrastructure dependencies from `application` and `domain`, reverse `services -> features` imports, and *new* `features ->` concrete client edges. The 62 existing feature edges are explicitly grandfathered in `architecture-baseline.json`; this is migration debt, not the desired end state.
- Added a repeatable two-window UI check for the changed room entry and exit scenario.

## AFTER architecture and guaranteed invariants

For the migrated operations only: one local controller owns the room join/leave transaction; duplicate joins and leaves coalesce; a cancelled late join cannot publish its room; a failed voice registration compensates by leaving the server room; a failed room close leaves the current room visible; snapshots for a departed room code cannot restore that room. `recovering` is a local connection state. The controller does not modify Room Server playback or audio timing.

The overall target architecture is **not yet reached**: `RoomSync` still orchestrates several services, `roomRef` remains a second local projection during synchronization, the majority of features still import concrete clients, and karaoke and C++ boundaries remain as before.

## Architecture rules

`frontend/scripts/check-architecture.mjs` runs at the start of `npm test`. Its synthetic test confirms rejection of forbidden edges and permits imports in `src/app` as the composition root. The checker currently scans static TypeScript imports and exports; it does not prove runtime ownership, and the temporary baseline still allows the listed feature edges.

## Verification

| Check | Result |
| --- | --- |
| Dedicated controller tests | 9 passed; the initial missing-controller test was confirmed red before implementation |
| React integration and room UI tests | Passed; new assertions were confirmed red before implementation |
| Architecture checker test | Passed; the missing-checker and reverse-edge cases were confirmed red before implementation |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 152 Vitest files / 730 tests, plus 82 Node tests passed and 1 skipped |
| `start-multy.bat` | Built frontend and native service; launched the normal developer and isolated guest profiles |
| Two-window rendered UI | Passed: create/join, guest leave, rejoin, host close, no renderer exceptions; both AudioService diagnostics captured |
| Process cleanup | Both windows closed; no matching Electron, Python backend, or AudioService processes remained |
| `npm run check:rules` | Failed on 9 pre-existing files above the 500-line limit, including `RoomSync`; this phase did not create those oversized files |

Live evidence: `artifacts/room-e2e/2026-10-07T17-46-57-225Z-session/report.md`, screenshots, and machine-readable `report.json`. This live check did not start karaoke or perform a project transfer and therefore does not establish audio synchronization or transfer correctness.

## Remaining risks and requested work

| Requested area | Status |
| --- | --- |
| RoomSync orchestration and complete application owner | Open; move project, voice, polling, readiness, start, and recovery in separately tested slices |
| All feature-to-client dependencies | Open: 62 baseline edges remain; shrink the baseline with each migration |
| Large karaoke hook | Open; map its lifecycle before moving operations |
| AudioService mutable internals | Open; native tests currently depend on the accessors; migrate tests to an appropriate test seam before removal |
| AudioService command routing | Existing handler groups are already present; inspect invariants before any further split |
| Python backend | Unchanged: no concrete architectural defect found in this phase |
| Full room/audio regressions | Open: no two-way microphone, 3–4 participant, 2 ms timeline, project transfer, recording, or device-switch evidence in this phase |

Of the requested lifecycle tests, this phase covers local transitions, duplicate join/leave, join retry, server/audio join failure, reconnecting state, stale response for a *different* room code, and join cancellation on leave. It does not yet cover partial project transfer, renderer reload, participant reconnect, leave/start race, double start, stale response after rejoining the *same* room code, cancellation during transfer, or AudioService restart recovery. No conclusion about those scenarios is drawn from this phase.

---

# Phase 2: frontend room/application boundary

Date: 2026-10-07. This is the separate phase report. The code migration is implemented, but **the phase is not complete under the mandatory live room gate**. The gate requires physical microphone capture and remote playback in both directions, a real project transfer and loader, 2 ms playback-position checks through the full karaoke lifecycle, and a saved performance mix. The current two-window diagnostic scenario does not exercise those cases.

## 1. BEFORE/AFTER dependency graph

```text
BEFORE: React RoomSync + feature hooks -> room/audio/Python/desktop clients
        React context and refs -> overlapping local session projections

AFTER:  React adapters -> RoomSessionController -> scoped room coordinators
        feature UI -> bounded application use cases / typed ports
        app composition root -> concrete services -> Room Server / AudioService / Python / Electron
```

The Room Server remains authoritative for the musical timeline, playback, readiness, and participants. The controller owns this renderer's membership and generation; bounded coordinators own transient project, voice, recovery, launch, diagnostics, and playback work.

## 2. What left RoomSync

Project import/export/transfer/readiness, voice registration and reconciliation, room polling and recovery, launch/navigation decisions, retries, calibration, timing diagnostics, and cancellation moved into application use cases. `RoomSync.tsx` shrank from 656 to 49 lines. It only attaches navigation/notification/curtain/chime UI callbacks, forwards backend readiness and preferences, issues the one-time restore command, and renders the scene curtain.

## 3. Local owner and use cases

`RoomSessionController.ts` is 231 lines and owns `disconnected | joining | joined | recovering | leaving | failed`, join/leave/close/restore, the current generation and abort signal, duplicate-command coalescing, and partial-join compensation. It delegates project/voice/recovery/launch/diagnostics to `RoomRuntimeCoordinator`, which composes one set of bounded coordinators for one session lease and stops them together. Project transfer and launch have their own discriminated operation states; server snapshots are never replaced by a local authority.

`KaraokePreparation`, `KaraokeRecovery`, `KaraokeRecordingCoordinator`, and `RoomPlaybackSynchronizer` now contain the corresponding asynchronous application work. React hooks subscribe and pass UI callbacks. The playback synchronizer also invalidates queued work on route disposal and reactivates correctly after React StrictMode effect replay.

## 4. Infrastructure imports and enforcement

The original architecture baseline contained 62 direct feature-to-service imports. It now contains zero. There are no remaining exceptions: `node scripts/check-architecture.mjs --print-debt` returns `[]`. Features use scoped port providers; only the `app` composition root wires concrete service clients. `npm test` runs the checker and its tests. It rejects feature-to-service imports, application/domain-to-React or concrete implementation imports, service-to-feature reverse imports, and lazy feature-to-service imports.

## 5. Races and partial failure

Automated tests cover start+leave, duplicate start and join, join→leave→late response, room A→B→late A response, old generation of the same room, project transfer→leave/reconnect, partial transfer and retry, voice registration→disconnect, AudioService and Room Server failure, renderer restoration, repeated reconnect, stale playback snapshots, route unmount, StrictMode effect replay, and old-session cleanup. Scoped operations check the room code and generation before applying results; transfer/launch cleanup runs when the lease ends. These tests prove those application transitions only, not the full live audio guarantee.

## 6. Test and live evidence

`npm run typecheck` passed. `npm test` passed: 168 Vitest files / 767 tests, and 87 Node tests passed with 1 skipped. `npm run check:rules` still reports seven pre-existing 500-line violations outside the newly changed code. No new line-rule violation was added.

The current local `start-multy.bat` diagnostic run passed in two rendered Electron windows: [`artifacts/room-e2e/2026-10-07T19-37-01-013Z-multi-electron-live/report.md`](../../artifacts/room-e2e/2026-10-07T19-37-01-013Z-multi-electron-live/report.md). It used a local Room Server, tested voice in both directions and reconnect with generated PCM, captured screenshots and diagnostics, and left no matching app processes. It did **not** prove real microphone capture, project-download loader/readiness, 3–4 participants, the 2 ms karaoke timeline across start/pause/resume/seek/stop/late join/reconnect/library, a saved in-product master recording, or Shared/Exclusive/ASIO switching.

Earlier local runs were intermittent: one failed with WASAPI Shared `DeviceLost` after about 31 seconds; another failed the personal-volume restoration check (0.063 versus baseline 0.099). See the timestamped reports under `artifacts/room-e2e/2026-10-07T19-25-20-294Z-multi-electron-live/` and `artifacts/room-e2e/2026-10-07T19-30-36-846Z-multi-electron-live/`. The successful run does not erase those failures.

## 7. Remaining work and risks

The frontend boundary now has one local session owner and zero direct feature-to-service imports. The mandated live room/audio validation remains open. Investigate the intermittent WASAPI device loss and personal gain restoration before claiming room stability. Then perform the real two-window microphone, transfer, synchronized-song, recording, and device-switch checks; the requested 3–4-participant evidence is also missing. C++ AudioService was not refactored in this phase. Oracle Room Server was not contacted while preparing this phase, respecting the free-tier constraint.
