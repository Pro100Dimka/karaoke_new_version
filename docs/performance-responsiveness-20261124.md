# Отзывчивость: редактор, библиотека, радио и аудиодвижок

Дата: 24 ноября 2026 года. Репозиторий: `karaoke_new_version`.
Рабочая ветка: `perf/responsiveness-20261124`, создана **до изменений** от
`main` на `a0839520fbd9dca6255a7b909cecac8985f787b5` (1.1.48).
Изменения не объединялись с `main`.

## Область и границы проверки

Проверены горячие пути редактора и библиотеки, файловые операции главного
процесса Electron, обновления каталога, SQL-пагинация, переключение радио,
загрузка медиа и завершение записи. Исправления относятся к воспроизведённым
проблемам и проверенным потребителям; это не доказательство отсутствия всех
возможных задержек во всём приложении.

Локальная среда — Linux, Node 24.22.3, Python 3.12.14 и GCC 14.
Интерактивные Windows/Electron, WASAPI/ASIO, микрофоны и два живых участника комнаты
в этой среде недоступны; сборку Windows и автоматические тесты дополнительно
проверил GitHub Actions. **Работа в части обязательной живой проверки комнат,
передачи проектов и аудиоустройств не завершена.** Требуемый `AGENTS.md`
прогон через `start-multy.bat` с обеими реальными UI-инстанциями не выполнен.
Автоматические тесты ниже этот gate не заменяют.

## 1. Редактор: ограничение частоты тяжёлого preview

`EditorPianoRoll` передавал каждое движение указателя в перестроение документа
и React. В воспроизведении 100 событий до следующего кадра вызывали 100 preview.
Теперь первый отклик немедленный; до следующего кадра сохраняется только
последнее движение. `pointerup` синхронно применяет конечные координаты до
завершения жеста. Escape, cancel, потеря capture и unmount отменяют отложенный
preview. Обычный клик без перемещения не создаёт изменение.

Отдельно устранена потеря конечной позиции: тест с последним движением на
0,2 секунды и отпусканием на 0,5 секунды теперь сохраняет 0,5 секунды.
Отмена из самого callback не может повторно запустить уже отменённый кадр.

Файлы: `frontend/src/pages/editor/EditorPianoRoll.tsx`,
`frontend/src/pages/editor/useEditorDragPreview.ts`.

## 2. Библиотека: поиск и объединение повторных обновлений

Сетевой поиск запускается после 200 мс без нового ввода. Очистка строки,
локальная фильтрация полного каталога и карточки текущего импорта остаются
немедленными. В тесте набор `Queen` создавал пять дополнительных HTTP-запросов;
теперь создаёт один.

Повторные уведомления каталога раньше отменяли React Query, но не останавливали
уже отправленные desktop HTTP-запросы. 30 уведомлений создавали 31 одновременно
незавершённое чтение. Теперь существующее чтение завершается, а изменения,
пришедшие во время него, объединяются в следующее чтение. Запросы, удалённые
при смене backend epoch, не восстанавливаются старым обновлением.

При импорте полный каталог сначала дожидается уже выполняющегося чтения, затем
применяет карточку песни. Это предотвращает перезапись нового элемента старым
ответом и повторный шквал отмен. Ожидание асинхронное; если серверное чтение
зависло, завершение операции импорта всё ещё зависит от его timeout. Карточка
ожидающего импорта остаётся видимой.

Файлы: `frontend/src/pages/library/songs/useLibraryCatalog.ts`,
`frontend/src/components/api-service.ts`.

## 3. Electron: дисковые проверки без остановки обработки событий

Проверки файлов при запуске и передаче аргументов заменены на асинхронные.
Сохраняются порядок команд, каноническая дедупликация, пропуск отсутствующих
файлов и лимит 50 существующих файлов. Проверка намерения запуска не читает
диск. Shutdown отменяет доставку команд, проверка которых ещё не закончилась.

Канонические пути архива комнаты и разрешённого корня проверяются через
асинхронный `realpath`. Защита от выхода за разрешённый корень сохранена;
отмена во время проверки прекращает загрузку до отправки файла.
Тесты удерживают дисковую операцию незавершённой и проверяют доступность других
команд, порядок и отмену.

Файлы: `frontend/electron/DesktopLaunch.ts`, `DesktopShell.ts`, `main.ts`,
`RoomProjectTransfer.ts`.

## 4. SQL: стоимость страницы не должна зависеть от сортировки всей истории

Добавлены индексы для порядка по времени и идентификатору, с фильтром по типу
события или песне. Они устанавливаются и для существующей библиотеки схемы 4.
Устаревший неуникальный индекс истории, который SQLite предпочитал новому
плану с полной сортировкой, заменён составным. Пользовательские данные сохранены.

Для нескольких типов истории используются ограниченные отсортированные выборки
по каждому уникальному типу и их общее слияние. Сохранены snapshot, стабильный
порядок при одинаковом времени, offset, пустые страницы и повторные типы фильтра.

Измерение: 6000 строк, страница 20 строк, offset 7. Это **инструкции виртуальной
машины SQLite**, приблизительно подсчитанные progress handler с шагом 100;
это не миллисекунды и не ускорение всего приложения.

| Запрос | До | После |
| --- | ---: | ---: |
| Вся история | 54 300 | 300 |
| История одного типа | 18 300 | 300 |
| История двух типов | 36 500 | 2 000 |
| Все записи | 162 200 | 400 |
| Записи одной песни | 27 600 | 400 |

Файлы: `python/backend/infrastructure/orm.py`, `migrations.py`, `sql_history.py`.
Прошли 44 целевых теста запросов, миграций и связанных потребителей.

## 5. Радио: отмена устаревшей работы во всей цепочке

Повторный поиск YouTube-потока из одного окна отменяет предыдущий. Отмена также
происходит при StopRadio, закрытии окна, завершении renderer и переходе на новую
главную страницу. Запросы другого окна и обычные backend-запросы не затрагиваются.
BackendEndpoint учитывает сигнал вызывающего кода вместе с timeout и shutdown.

Python ограничивает параллельные поиски двумя; ожидающие запросы не занимают
общий пул синхронных worker-потоков. Disconnect и отмена родительской ASGI-задачи
передаются существующему ProcessRunner, который останавливает ненужный yt-dlp
и дожидается освобождения процесса. Отмена не маскирует обычные ошибки resolver.

Регрессии проверяют 16 удерживаемых запросов при общем пуле из четырёх потоков:
health продолжает отвечать, одновременно работают не более двух resolver.
Проверены отмена ожидающего и активного запроса, обе стадии поиска, смена
станции, изоляция окон и отмена родительской задачи. 17 Python-тестов радио
прошли; для Electron также прошли соответствующие signal/IPC-тесты.

Файлы: `frontend/electron/ServiceIpc.ts`, `BackendEndpoint.ts`,
`python/backend/api/radio_routes.py`, `infrastructure/youtube_radio.py`.

## 6. Аудиодвижок: загрузка источника и подавление денормализованных хвостов

Перед новым Load убрано обязательное ожидание полного unload предыдущего decoder.
Команда сохраняет последний путь для worker, сбрасывает старый PCM и публикует
Loading. В тестах с удерживаемым open/read новая команда отвечает до освобождения
старой операции. Worker владеет close/open и пропускает вытесненные загрузки; старые PCM,
формат, прогресс и ошибки не могут перезаписать новый источник.

При Stop/Seek/Rate/Transpose во время open подготавливается тот же decoder,
после чего применяется последняя команда. Ошибка открытия текущего файла
сохраняется и при изменении транспорта; некорректный ожидающий seek удаляется.
Без этой проверки была возможна вечная Loading и бесполезная работа worker.
При этом ошибка отменённого loudness scan относится к старому транспорту:
она не должна стирать новый seek уже подготовленного decoder. Эта граница
проверена отдельно для Stop, Seek, Rate и Transpose.

Явные unload, смена формата выходного устройства и разрушение объекта сохраняют
синхронное ожидание освобождения decoder: это необходимо для владения буферами.
Физический Windows Media Foundation open всё ещё может ждать сетевую операцию,
которую существующий decoder не умеет прервать до публикации source reader.
Следующий источник и эти операции могут ждать её завершения. Поэтому гарантии
«любое переключение всегда мгновенно» здесь нет. Кроме того, существующий
Windows `decoder.cancel()` использует синхронный `IMFSourceReader::Flush` и
`readerMutex`; задержки этих платформенных операций требуют живого profiling.
Они не переписывались и этим тестовым decoder не измерялись.

В расчёте громкости добавлена scoped-защита от denormal floating point tails.
На синтетическом сигнале «импульс 0,5 и затем цифровая тишина», 60 секунд
моно PCM при 48 кГц, измеренный участок K-weighting занимал
**792,9 → 12,34 мс** (примерно 64×), с тем же напечатанным checksum
`2.2433e-12`. Это один узкий CPU-бенчмарк с `-O2`, не время загрузки
произвольной песни. Режим floating point вызывающего потока восстанавливается.
Отменённый scan также больше не делает ненужный rewind decoder.

20 различных целевых native-функций тестирования прошли, включая новые гонки и
существующие seek, loop, scheduled playback, loudness и unload. После последнего
уточнения фазы scan повторены 11 затронутых функций в штатном native executable;
они прошли и не прибавляются второй раз к количеству. Сборка выполнена GCC 14,
C++20, с `-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Werror`.

Файлы: `AudioService/src/media/MediaSource.cpp/.hpp`,
`AudioService/tests/media/MediaLoadingTests.cpp`, `tests/dsp/LoudnessTests.cpp`.

## 7. Остановка записи: освобождение native-команд до конца обработки WAV

Обычный StopRecording ждал полного прохода нормализации и публикации WAV
в disk worker. Поэтому длительность записи и скорость диска влияли на время,
в течение которого единственный control pipe не мог обработать следующую команду.

Добавлен необязательный `StopRecording|async=true`. Граница захвата, принятый
хвост и переход в Finalizing остаются прежними. После этого команда возвращает
путь, а существующий worker завершает запись. Этот ответ подтверждает остановку
захвата; доступность файла подтверждает только Finished. Обычный StopRecording
сохраняет синхронный контракт для существующих вызывающих мест и shutdown.

Проверка удерживает producer lease, поэтому worker заведомо не может закончить:
асинхронная остановка, GetRecordingState и GetClock отвечают; обычный stop ждёт
освобождения producer. Проверены Prepared, Recording и Paused, повторная остановка,
запрет нового PrepareRecording и поздняя ошибка writer. В момент ответа возможен
переход Finalizing→Finished/Failed; повторное чтение результата исключает ложную
ошибку из-за устаревшего snapshot.

Отдельно устранено изменение dry-companion после окончания интервала записи:
поздний голос другого участника не может объявить уже остановленную/приостановленную
solo-запись неполной. Признак remote внутри принятого PCM-блока сохраняется.

Нормализация, общий gain, headroom, PCM16-публикация и companion-файлы сохранены.
19 выбранных native-тестов прошли в штатном `audioservice_tests`, собранном
с настоящими закреплёнными в CMake codec-зависимостями и warnings-as-errors.
Включены точные PCM/cutoff проверки асинхронного stop на блоках 128 и 480 frames,
fractional tail, смена generation/устройства, producer drain, shutdown, шесть
выходных каналов, companion и отказы writer.

Аварийное отсутствие callback и ожидание места для принятого хвоста сохраняют
прежние deadline по 2 секунды. Само платформенное восстановление backend остаётся
синхронным и не получило гарантированного timeout. Это изменение убирает обычное
ожидание полной нормализации файла из control pipe, а не заменяет необходимую
синхронизацию записи с аудиоустройством.

Контракт: `AudioService/docs/specification/AudioService-runtime-media-extension.md`.
Реализация: `RecordingEngine`, `RealtimeEngine`, `SessionManager`,
`AudioServiceCommands`.

## 8. Ожидание записи в интерфейсе и цикл двух очередей

Обычное сохранение в `recordingCoordinator` использует асинхронный stop и
опрашивает Finalizing раз в 100 мс. `finalizedPath`, чтение WAV, сверка metadata
и регистрация в библиотеке происходят только после Finished. Failed сохраняет
конкретное сообщение native writer. Прерывание session между запросами запрещает
применять ответ новой audio-session к старой записи.

Ожидание одного обращения ограничено 120 секундами. Timeout сохраняет take и
принятый путь; повторная попытка продолжает ожидание того же файла. Незавершённая
запись не удаляется и не публикуется. Pause/Resume/Start не могут ошибочно продолжить
уже финализируемую запись. Cleanup прерванной или неподготовленной записи сохраняет
синхронную остановку перед восстановлением/удалением пустого target.

Независимая проверка выявила цикл двух очередей: Stop удерживал recording transition
и ждал `onCaptured → audioClient.stop`; параллельная смена устройства удерживала
очередь audio operations и ждала этого Stop. Теперь смена устройства ожидает только
подтверждение границы capture, после чего может выполняться независимо от disk worker.
Stop сохраняет порядок следующего Start и дожидается начатой смены устройства.

Граница регистрируется уже при постановке Stop в очередь. Проверены Stop за ещё
незавершённым Start, удерживаемый native-ответ, принятый stop, отказ и потеря ответа,
повторный stop, доступность следующей audio-команды и новый Start при незавершённом
Reconfigure. Три сценария с настоящим `audioClient.applyConfiguration` сначала
воспроизвели deadlock, затем прошли после изменения.

Прошли 82 связанных теста в шести suites. После усиления проверок потерянного ответа
и порядка Start повторно прошли 16 тестов finalization suite; повтор не прибавляется
к количеству. Независимая проверка кода закрыла замечания к порядку обеих очередей.

Файл реализации: `frontend/src/services/recordingCoordinator.ts`.
Новые регрессии: `recordingCoordinator.finalization.test.ts`.

## Проверки и воспроизведение

До исправлений новые регрессионные проверки воспроизводили соответствующие
проблемы. Локально после изменения запускались затронутые тесты и потребители;
полные frontend/backend/native suites локально не запускались. После публикации
ветки репозиторий автоматически запустил штатный CI, результаты приведены ниже.

| Область | Результат локальной проверки |
| --- | --- |
| Редактор, поиск, обновления и импорт библиотеки | 107 различных тестов PASS |
| Renderer: запись и связанные audio-потребители | 82 теста PASS |
| Electron | 63 PASS в основной выборке и 17 PASS после radio/cancellation изменений; выборки частично пересекаются |
| Python: страницы истории/записей и миграции | 44 PASS |
| Python: радио и отмена | 17 PASS |
| Native: media/loudness | 20 различных функций PASS; затронутые последней правкой повторены |
| Native: запись и её потребители | 19 функций PASS |
| TypeScript renderer + Electron | PASS на конечном production-коде |
| Frontend architecture | PASS на конечном production-коде |
| Python Ruff lint/format, адресная architecture-проверка и mypy Win32 | PASS |

Полный native test target собран, но тестовый executable запускался только с
конкретными именами проверок. Это не полный native suite и не живой room E2E.

Python, из `python`:

```bash
python -m pytest tests/test_library_page_query_cost.py tests/test_history_responsiveness.py tests/test_recording_list_responsiveness.py tests/test_migrations_lifecycle.py tests/test_history_settings.py -q
python -m pytest tests/test_radio_responsiveness.py tests/test_youtube_radio.py -q
python -m ruff format --check backend/infrastructure/orm.py backend/infrastructure/migrations.py backend/infrastructure/sql_history.py backend/infrastructure/youtube_radio.py backend/api/radio_routes.py tests/test_library_page_query_cost.py tests/test_radio_responsiveness.py tests/test_youtube_radio.py
python -m ruff check backend/infrastructure/orm.py backend/infrastructure/migrations.py backend/infrastructure/sql_history.py backend/infrastructure/youtube_radio.py backend/api/radio_routes.py tests/test_library_page_query_cost.py tests/test_radio_responsiveness.py tests/test_youtube_radio.py
python -m mypy --platform win32 backend/infrastructure/orm.py backend/infrastructure/migrations.py backend/infrastructure/sql_history.py backend/infrastructure/youtube_radio.py backend/api/radio_routes.py
```

Ruff прошёл для всех восьми изменённых Python-файлов. Внутренние text/AST
architecture-проверки также прошли для пяти изменённых production-модулей;
это адресная проверка, а не полный project-wide backend gate.
Финальные Ruff lint/format, mypy и повторные 44 SQL-теста прошли с версиями
из CI: Ruff 0.16.8, mypy 1.20.2 и SQLAlchemy 2.0.54. Две явные локальные
аннотации в миграциях устраняют неоднозначный вывод generic scalar-типа;
поведение запросов и данных не меняется.

Renderer/Electron, из `frontend`:

```bash
./node_modules/.bin/vitest run --maxWorkers=1 \
  src/pages/editor/EditorPianoRoll.responsiveness.test.tsx \
  src/pages/editor/EditorPage.gestures.test.tsx \
  src/pages/editor/EditorPage.active-gesture.test.tsx \
  src/pages/editor/EditorPage.virtualization.test.tsx \
  src/pages/library/songs/useLibraryCatalog.typing.test.tsx \
  src/pages/library/songs/useLibraryCatalog.test.tsx \
  src/pages/library/songs/useLibraryCatalog.search-folding.test.tsx \
  src/pages/library/songs/useLibraryCatalog.progress.test.tsx \
  src/components/api-service.refresh.test.ts \
  src/components/api-service.import.test.ts

./node_modules/.bin/vitest run --maxWorkers=1 \
  src/components/api-service.import.test.ts \
  src/components/api-service.refresh.test.ts \
  src/pages/library/modals/add-song/useLibraryImport.test.tsx \
  src/pages/library/songs/useLibraryCatalog.test.tsx

./node_modules/.bin/vitest run --maxWorkers=1 \
  src/services/recordingCoordinator.finalization.test.ts \
  src/services/recordingCoordinator.test.ts \
  src/services/recordingCoordinator.lifecycle.test.ts \
  src/features/karaoke/useKaraokeSession.recording.test.tsx \
  src/features/karaoke/karaokeAudioLifecycle.test.ts \
  src/services/audioClient.voiceLifecycle.test.ts

./node_modules/.bin/vitest run --maxWorkers=1 \
  electron/BackendEndpoint.test.ts \
  electron/ServiceIpc.radio.test.ts \
  electron/ServiceIpc.test.ts \
  electron/DesktopLaunch.responsiveness.test.ts

npm run typecheck
npm run check:architecture
```

Первые две renderer-выборки дали 95 и 34 PASS с пересечением; после последнего
добавленного import case это 107 различных тестов. Recording-выборка добавляет
82 других теста: всего 189 различных renderer-тестов. Последний повтор
`recordingCoordinator.finalization.test.ts` после усиления assertions дал 16 PASS.

Штатная native-сборка из корня (после установки CMake/Ninja/GCC 14):

```bash
cmake -S AudioService -B .dev-data/temp/responsiveness-native/build -G Ninja \
  -DCMAKE_C_COMPILER=gcc-14 -DCMAKE_CXX_COMPILER=g++-14 \
  -DCMAKE_BUILD_TYPE=Release -DAUDIOSERVICE_WARNINGS_AS_ERRORS=ON \
  -DAUDIOSERVICE_BUILD_TESTS=ON -DAUDIOSERVICE_BUILD_RELEASE_GATES=OFF
cmake --build .dev-data/temp/responsiveness-native/build --target audioservice_tests --parallel 4
```

Каждая выбранная recording-функция запускалась отдельным процессом
`.dev-data/temp/responsiveness-native/build/audioservice_tests <имя>`:

```text
asynchronousRecordingStopLeavesControlResponsive
asynchronousRecordingStopReportsWriterFailure
pausedPerformanceKeepsItsDryStemWhenRemoteVoiceArrives
performanceFinishKeepsLiveAudioAndFrozenCutoff
performanceFinishRecoversAfterFatalCallback
performancePendingCaptureRespectsPhysicalCutoff
performancePendingCaptureRetainsFractionalTail
performanceTailWaitsForSmallQueuesAndReportsWriterFailure
performanceDrainFailureNeverClaimsFinalization
performanceRecordingDrainsBeforeDeviceGenerationChanges
controlledReconfigurePreservesOnePerformanceFile
recordingStopDrainsAnInFlightProducer
recordingShutdownFinalizesAcceptedPcm
recordingGenerationChangeFinalizesTheExistingFormat
performanceCompanionPreservesTheAlignedBacking
performanceHeadroomFinalizesAllOutputChannels
masterCompanionSharesOverrunsAndLifecycle
recordingTimelineClosesWithLifecycle
stopRecordingReportsWriterFailure
```

20 различных media/loudness функций (первые 19 — минимальный C++ runner,
последняя и десять затронутых потребителей — дополнительно штатный executable):

```text
songLoudnessScanDoesNotProcessSubnormalTails
cancelledSongLoudnessScanDoesNotRewindDecoder
loudnessWeightingFollowsHearing
songsPlayAsLoudAsStreamingNotLouder
songLoudnessIsMeasuredOnLoadIgnoringSilence
replacementMediaLoadDoesNotWaitForPreviousDecoder
mediaReconfigurationStillWaitsForDecoderQuiescence
unloadingMediaStillDrainsTheDecoder
transportChangesDuringMediaOpenStillPrepareTheDecoder
transportChangesDuringFailedMediaOpenRetainTheFailure
queuedMediaLoadKeepsTransportChanges
loadingProgressReportsRealScannedFramesWithoutMovingPlayback
seekUpdatesAuthoritativePosition
unloadQuiescesDecoderWorker
stoppingFailedMediaPreservesTheFailureUntilReload
previewLoopStaysInsideRange
mediaReconfigurePreservesScheduledPlayback
staleDecodedPcmNeverLeaksAfterSeek
stoppingLoadingMediaWaitsForDecodedAudio
transportChangesDuringFailedLoudnessScanStillSeekTheSource
```

Для Windows следует использовать соответствующие адресные команды `check.bat`
из корня репозитория. Для комнат и передачи проекта дополнительно обязателен
живой сценарий через `start-multy.bat`; результаты этого сценария в данном
отчёте отсутствуют.

## GitHub Actions после публикации

В [run 45457068099](https://github.com/Pro100Dimka/karaoke_new_version/actions/runs/45457068099)
для опубликованного `c4992aca4b802840beaaa9bfad7bd9293d5ce6fa`:

| Проверка | Наблюдаемый результат |
| --- | --- |
| Native Linux/GCC 14: configure, build, полный CTest | Success |
| Native Windows/MSVC: configure, build, полный CTest | Success |
| Frontend Windows: install, typecheck, полный npm test, build | Success |
| Python fast/release | Остановились на форматировании двух новых тестовых файлов |

Замечание форматирования исправлено следующей правкой, перепроверено с Ruff из
CI вместе с lint, mypy и SQL-тестами. Эта правка меняет только оформление тестов,
аннотации типов и данный отчёт; проверенный C++/frontend-код сохраняется.
Первоначальный CI не объявляется полностью зелёным, а его автоматические Windows
тесты не заменяют обязательный живой room/audio сценарий.

Последующий [run 45459064719](https://github.com/Pro100Dimka/karaoke_new_version/actions/runs/45459064719)
для `1a8042550aba45a59a5f2d54ae6fa30470940840` завершился успешно:
frontend, native Windows, native Linux, Python fast, integration и release.
Следующий проход в той же ветке описан в [отчёте о продолжении](performance-responsiveness-continuation-20261124.md).

## Оставшиеся ограничения

Сетевые серверы, файловая система и драйверы могут отвечать медленно; в проверенных
местах устранено ожидание на чувствительном к нему потоке либо лишняя работа,
но это не ограничивает задержки внешних компонентов. Большие документы всё ещё
требуют синхронной сериализации и записи recovery draft через localStorage;
изменение этого хранилища требует отдельной миграции с сохранением восстановления
и порядка записей. Частоту тяжёлых drag-preview этот проход уже ограничивает.

В продолжении от 24 ноября обычный autosave переведён на компактный draft
с серверным отпечатком исходного документа. Полное хранилище не мигрировалось;
измерения, совместимость и оставшиеся границы приведены в отдельном отчёте выше.

Измерений FPS реального Windows-интерфейса, задержки микрофона, underruns на
физических устройствах и синхронизации двух живых участников этот отчёт не содержит.
