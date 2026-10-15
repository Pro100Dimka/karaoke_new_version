# Direct voice late recovery — воспроизведение и доказательства

Дата: 2026-10-15. Исходный HEAD: `7461968f`; native baseline на двух ПК —
`4b4f1895`. Room timing policy остаётся `660e8225`. Этот документ не меняет
[исходный TEST_PLAN](../2026-10-15-physical-directional/TEST_PLAN.md) или
[PHYSICAL_LIVE_GATE_V2](../2026-10-15-physical-directional/PHYSICAL_LIVE_GATE_V2.md).
Приведённые ниже исторические пропадания уже доказаны PCM; новая packet trace
нужна для локализации и фактического replay, а не для повторного аудита устройств.

## Что было сохранено в предыдущем физическом gate

Авторитетная пара находится в `../2026-10-15-real-mic-v2/`:

- `ui-host-to-laptop-repeat-*`: deadline 55 мс, 44 активных native PCM silence
  intervals >=1 мс, total 504 мс, longest 92.667 мс, direct late cuts +828.
- `ui-laptop-to-host-repeat-*`: deadline 72.5 мс, один подтверждённый gap
  156.625 мс, direct late cuts +195. Принятый lag 72.563 / 72.670 / 72.659 мс,
  drift +0.097 мс. Это не принятие непрерывности.

Точные WAV samples важнее округлённой позиции песни:

| Направление / gap | Receiver WAV start / length, frames | Room presentation frame начала | Song time по CSV, с |
|---|---:|---:|---:|
| host → laptop, 92.66667 мс | 393952 / 4448 | 86020395104976 | 14.100041667 |
| host → laptop, 69.25000 мс | 5895641 / 3324 | 86020400606664 | 128.718541667 |
| laptop → host, 156.62500 мс | 5009762 / 7518 | 86020410162227 | 105.477854167 |

Ранее сохранённые `gap-coordinates.json` содержат номинальные songSeconds
14.1002885 / 128.7188094 / 105.4709087. Для точной пакетной привязки брать
WAV frame и **соответствующую строку CSV**, а не экстраполировать от первого
блока: room-clock observation может корректироваться. Sender expected WAV
frames 458332 / 5960158 / 4942084 — подсказки по ближайшему уверенно найденному
контексту; отсутствующий сигнал не позволяет объявить их точной идентичностью
потерянного datagram.

В ±500 мс sender-контексте каждого gap запись непрерывна, все capture stamps
валидны, effective timeline увеличивается ровно на 120 frames. Оба sender codec
были Pcm16. Recording gaps / overruns / stale blocks равны нулю.

Сохранённые GetDiagnostics — снимки с фактическим шагом около 5–8 с, иногда
дольше. Они дают только следующие ограничения для direct peer:

| Gap | UTC интервал снимков | Δ late cuts | Δ decoded nonzero | Δ queued nonzero | Δ render underruns | Δ jitter lost |
|---|---|---:|---:|---:|---:|---:|
| A 92.667 мс | 19:12:40.799–19:12:46.322Z | 80 | 2223 | 2143 | 42 | 0 |
| A 69.250 мс | 19:14:38.813–19:14:44.294Z | 143 | 2186 | 2043 | 53 | 0 |
| B 156.625 мс | 19:17:56.658–19:18:03.776Z | 59 | 2872 | 2813 | 118 | 4 |

Во всех трёх интервалах decoded−queued совпадает с cuts. Это подтверждает
отбрасывание после decode в агрегате, но не назначает каждый packet конкретному
PCM gap. TimelineExcluded=0 на границах не исключает краткое exclusion внутри.
Нулевой jitter lost не доказывает своевременную доставку: deadline rejection —
другая стадия. Underruns считаются render calls, а cuts — affected packets.

Нет исторического per-packet sequence/arrival trace этих трёх событий.
Network WAV CSV хранит pre-codec PCM/effective/capture frame, master CSV — output
presentation frame. Ни один из них не хранит sequence или socket receive time.
`TraceSize` и `RemoteReturnTracePackets` являются другими агрегатами.
Старый arrival pattern восстановить из этих файлов нельзя. Duration-calibrated
93/157 мс regression не следует называть точным историческим arrival replay.

Host maximum successful relay-send gap в A оставался 5.492 мс; результат direct
sendTo не счётчик NetworkPacketsSent. Laptop maximum 344769 мс уже существовал
до B и маскирует последующие короткие send stalls. Старые receive-gap maxima
129715/279842 мкс тоже нельзя присвоить этим событиям.

## Новый baseline: реальные arrival/decision данные

Запустить обычный baseline AudioService на обоих физических ПК с
`AD_VOICE_ROOM_PACKET_TRACE=1` и `AD_VOICE_ROOM_E2E=1` **до создания процесса**.
Второй флаг нужен существующей explicit diagnostic rearm command; без него
получается `4|Room E2E mode is disabled`, и trace не перевзводится. Сохранить проверяемый
native SHA и конфигурацию. Не менять deadline, codec, устройства и route policy.
Сценарий, реальный mic, уровни и Monitoring OFF — как в V2.

Используется существующий `RoomPacketDecisionTrace`: seq/epoch/musicalFrame,
socketReceiveMicros, processingMicros, decisionMicros, socket/receive/decision
room timeline, targetPresentationFrame, slacks, dueInFrames, queueFillFrames,
lateSkipFrames, nonzero и decision. Это 96-event ring; он замораживается после
первого sustained nonzero cut burst с 40 post-trigger decisions. Пустой muted
server mix нельзя подменять активным direct stream.

**Сохранять RAW вывод GetDiagnostics на обоих ПК.** В нём несколько строк
`RemotePacketTrace.<peer>`. `Object.fromEntries` или обычный dict по имени поля
оставит только последнюю строку и уничтожит trace. Допустим отдельный raw TXT
на каждый снимок; исходный capture JSON со счётчиками тоже оставить.

Label новых исходных записей:
`baseline-host-to-laptop-*` и `baseline-laptop-to-host-*` в этом каталоге.
Сохранить sender `tap=network`, receiver `tap=master backing=true`, все три WAV
и обе timeline CSV. Записывать через UI на двух реальных ПК по V2, без WAV
инъекции. Trace snapshots не заменяют саму физическую проверку.

Порядок перевзвода:

1. Через UI проверить роли, Music/Vocal=0 на sender для тихого lead, Monitoring OFF.
2. Начать **оба** diagnostic WAV tap; записать 3 с настоящего тихого микрофона.
3. Через UI включить Vocal sender, не меняя mic/network route.
4. После Vocal ON на обоих процессах выполнить существующий diagnostic command:
   `AudioControl.exe SetDiagnosticRoomInput enabled=false resetLateCutSeries=true`.
   Указать правильный Dev pipe/SSH wrapper для каждого ПК; сохранить raw reply.
5. Требовать `0|DiagnosticRoomInputUpdated` для обоих. Проверить
   DiagnosticInputMode=Disabled; не передавать filePath, frequency/gain или enabled=true.
6. Сохранять RAW GetDiagnostics до конца burst/recovery. Финализировать оба WAV,
   проверить recording gaps/overruns/stale blocks=0 и скопировать sidecars.

Флаг E2E здесь разрешает diagnostic command, а не подстановку сигнала. Сама
команда оставляет diagnostic input отключённым. Reset перевзводит существующий
bounded packet ring; audio policy/queue/timestamps не меняются.

Существующая trace описывает **delivered/reordered packets**, не raw RX rejects,
JitterPopOutcome::Lost или каждый renderRemote call. Она позволяет исследовать
реальные observed arrivals и late decision. Если frozen burst до начала WAV,
source coverage будет неполной; такой результат не объявлять полным PCM replay.

## Извлечение fixture без потери повторяющихся ключей

Из корня репозитория, пример для A (указать фактический glob raw TXT):

```powershell
python artifacts/room-e2e/2026-10-15-direct-late-recovery/extract_direct_replay.py `
  --diagnostics 'artifacts/room-e2e/2026-10-15-direct-late-recovery/baseline-host-to-laptop-laptop-raw-diagnostics.jsonl' `
  --peer b3fa1990ed540274e974103b79e33558 `
  --sender-timeline artifacts/room-e2e/2026-10-15-direct-late-recovery/baseline-host-to-laptop-sender-mic.wav.timeline.csv `
  --sender-wav artifacts/room-e2e/2026-10-15-direct-late-recovery/baseline-host-to-laptop-sender-mic.wav `
  --codec Pcm16 `
  --receiver-timeline artifacts/room-e2e/2026-10-15-direct-late-recovery/baseline-host-to-laptop-receiver-master.wav.timeline.csv `
  --output artifacts/room-e2e/2026-10-15-direct-late-recovery/baseline-host-to-laptop-replay.json
```

Для B receiver — host; peer laptop `b4c834113c5f11f8e254b5b9c5dbcb97`. В новой
voice session participant IDs могут измениться: брать фактический direct peer
из сохранённого room/UI evidence и Raw GetDiagnostics, не угадывать.

Extractor:

- сохраняет все repeated trace rows, убирает одинаковые frozen snapshots;
  конфликтующий generation/epoch/sequence отвергает;
- сортирует по **реальному socketReceiveMicros**, не по sequence;
- сопоставляет musicalFrame с точным effective stamp sender CSV;
- включает source PCM16 samples из sender WAV без изменения длины/частоты;
  это WAV reference PCM, не побитно захваченный encoded datagram;
- сохраняет реальные master presentation blocks и кусочную target→WAV mapping;
- не подставляет данные для отсутствующего source/target; отмечает incomplete;
- пишет JSON и flattened CSV, input paths и SHA-256.

RAW JSONL с полями `at` и `raw` поддерживается непосредственно. Native CSV
начинается колонками `arrivalOffsetMicros,sequence,timestampFrame,frames,codec,
originalDecision,pcm16OffsetSamples,pcm16Samples`. Codec 1 = Pcm16; его требуется
подтвердить diagnostics отправителя, потому что сама packet trace codec не
сохраняет. `*.pcm16` — little-endian signed16 mono reference samples; offsets
считаются в samples, не bytes. `*.mapped.csv` содержит только точное совпадение
source PCM с валидным capture clock; полный JSON/CSV сохраняет также непокрытые
события. `mappedSubsetOnly=true` явно сообщает, что это подмножество.

Несколько замороженных окон до/после reset нельзя склеивать как сплошную сеть:
промежуток между ними — отсутствие trace coverage. Сохранены `traceSegmentId`,
`traceCoverageBoundaryBefore` и JSON `traceSegments`. Replay каждого segment
запускать отдельно; sequence gaps между segments не моделировать как packet loss.

### Первый новый baseline A: evidence complete, replay PCM incomplete

`baseline-host-to-laptop` (старый native `4b4f1895`) выбрал 57.5 мс. UI gate
прошёл. Его raw trace содержит два раздельных замороженных окна по 96 decisions;
последний musicalFrame находится за 427.5 мс **до** первого sender WAV packet.
Поэтому `baseline-host-to-laptop-trace-timing-only.*` сохраняет actual timing,
но имеет 0 mapped packets, пустой PCM и явный INCOMPLETE. Нельзя подкладывать
позднейший микрофонный PCM и называть его source этих sequences.

Для следующего baseline необходимо после включения физического vocal source
и начала обоих WAV явно перевзвести существующую trace через диагностический
reset. Инструментированный baseline должен отличаться от старого аудиопути
только этим диагностическим rearm. Сохранить исходный SHA и отдельную точную
instrumentation patch. Input остаётся Disabled, никакой WAV source substitution.

Полный PCM baseline A всё равно пригоден для исходной continuity оценки:
unchanged V2 analyzer дал 19 активных zero intervals >=1 мс, total 267.4375 мс,
longest 64.02083 мс (song 31.5941285). Один gap >=60 мс; direct cuts +373 в
исходной playback epoch. Start/middle приняты 20/20, end только 11/14:
общий lag/drift не принят. Whole-song component check INDETERMINATE с 60 мс
unknown, а не zero dropouts. Результаты в `baseline-host-to-laptop-metrics.json`,
полные unchanged strict/approved analyses сохранены отдельно. Это baseline,
не финальная приёмка исправления.

### Успешный rearmed diagnostic trace 3

`baseline-trace3-host-to-laptop-cut-burst.*` содержит 96 последовательных
observed decisions (seq 22758–22853) с **96/96 exact sender PCM mappings** и
валидными capture clocks. Внутри одного окна зафиксирован socket receive gap
103019 мкс, затем 13 QUEUE_LATE packets seq 22809–22821. Все packets реально
пришли, были декодированы и отвергнуты этой поздней decision. Первые 12 имели
отрицательный socket deadline slack, последний — +84 frames; future render
cursor уже прошёл весь packet во всех 13 случаях, queue fill равен нулю.
Этот последний случай не объявлять спасаемым без учёта уже submitted audio.

Для этих 13 packets сохранённые lateSkipFrames равны
2026 / 1906 / 1786 / 1666 / 1546 / 1426 / 1306 / 1186 / 1066 / 946 / 826 / 706 / 586:
12.208–42.208 мс, среднее 27.208 мс относительно уже продвинувшегося consumer
cursor. Дополнительные 2.5 или 5 мс не сделали бы своевременным ни один из этих
13 packets: даже конец последнего 120-frame packet остаётся позади cursor.
Это оценка временной пригодности **наблюдённого snippet**, не моделирование
переклассификации counters и не статистика всех cuts. Elastic reserve не
внедрялся: в этом burst нет доказательства, что несколько мс исправят длинный
gap. Обобщать 0/13 на остальные пакеты или всю сеть нельзя.

**Важный диагностический mismatch:** server reported 140 мс и sender native
6720 frames, но receiver native и все trace events — **4080 frames = 85 мс**.
В replay использовать фактические 4080, не HTTP 140. Этот короткий take не
является physical acceptance. Не менять timing policy ради него; финальный
полный take требует совпадающих server/native deadlines до записи.

Эти 96 packets находятся внутри исходной песни и обоих WAV: source song
38.106333–38.343833 с. `*.pcm16` содержит все 11520 source samples, а
`*.render.csv` — 124 измеренных master blocks по 480 frames. Для 96/96 packets
`receiveTimelineFrame` и `decisionTimelineFrame` **точно** совпадают с концом
одного master block (`timelineFrame + frames`). Это позволяет воспроизвести
observed packet arrival order при точных consumer milestones. CSV не хранит
callback wall-clock execution times; их нельзя выдать за измеренные. Scope и
полнота join сохранены в `baseline-trace3-host-to-laptop-cursor-join.json`.

В исходном exact master−backing рядом с этим burst есть 1731-frame zero interval,
36.0625 мс, на обоих receiver channels. Координаты и presentation spans —
`baseline-trace3-host-to-laptop-cut-burst-pcm-evidence.json`. Эта длительность
не равна 13×2.5 мс: affected packet count и фактический render gap различаются.

Arrival micros — локальный steady clock receiver. Для replay использовать
`arrivalMicrosFromFirst`, не смешивать его с Unix/room frames. Media и target
frames — 48000 Hz. Render blocks сохраняют собственный native sample rate.
CSV `timestampFrame` является чистым musicalFrame: существующая trace уже сняла
SharedAudioTimelineFlag. При сборке wire AudioPacketHeader для shared-room replay
флаг требуется вернуть; не отправлять такой frame как conversation timestamp.

Запуск dedicated extraction tests:

```powershell
python artifacts/room-e2e/2026-10-15-direct-late-recovery/test_extract_direct_replay.py -v
```

`extractor-tests-red.txt` сохранён до реализации; одиннадцать dedicated tests прошли
после неё. Они проверяют repeated keys, dedup/conflict, arrival order, epoch/peer
изоляцию, точный source PCM, кусочную clock mapping и явную неполноту. Дополнительные
RED→GREEN logs фиксируют поддержку actual RAW JSONL/native format и запрет выдавать
разрыв trace windows за реальный network stall.

## Как интерпретировать trace и сравнивать replay

Для каждой sequence сохранить source musical/capture frame, фактический arrival,
decision reason, target presentation, lateSkip и queue fill. Positive socket
slack означает, что wall-clock target ещё впереди; это само по себе не доказывает,
что уже переданный устройству output buffer можно переписать. Проверить также
decision/render cursor и неизменяемую очередь. Negative socket slack доказывает
опоздание к этому wall-clock target. Type 1/2 не выводить из одного counter.

Новый replay должен использовать записанный observed arrival order/timestamps
и source PCM; сохранить SHA fixture. Не заменять его random loss. Для absent
trace stages прямо оставить UNKNOWN. Старые 93/157 мс — отдельные ограничения
по измеренной продолжительности; они не содержат точной исторической доставки.

До/после на одинаковом fixture и deadline сохранить:

- missing PCM duration, longest zero interval, late cuts, recovery time;
- added latency относительно unchanged target, drift после recovery;
- queue fill maximum/end и возврат к nominal alignment;
- число generated concealment frames, продолжительность непрерывной PLC серии,
  момент возврата первого timely voice packet.

Не считать неравенство нулю доказательством сохранённого голоса: PLC/noise может
быть nonzero и при отсутствии исходной информации. Измерять также real-mic
matched component и отдельно помечать concealment. Длинное продолжение pitch
не должно бесконечно заполнять stall. Отброшенный old timeline PCM не воспроизводить
после закрытого musical position.

Focused native regression commands (из корня репозитория):

```powershell
AudioService/build/Release/audioservice_tests.exe directRenderContinuityBoundsSavedGapDurations
AudioService/build/Release/audioservice_tests.exe directRenderContinuitySurvivesSocketSilenceAndRejectsStaleBacklog
AudioService/build/Release/audioservice_tests.exe directRenderContinuityCannotLeakAcrossMuteOrQueueReset
AudioService/build/Release/audioservice_tests.exe observedDirectPacketBurstKeepsBoundedPlayoutContinuity
```

`BoundsSavedGapDurations` использует измеренные **длины** 3 / 92.667 / 156.625 мс;
это duration-constrained regression, а не восстановление старой доставки.
Его `missingPcmMs`/`longestZeroMs` измеряют абсолютную тишину. PLC может сократить
тишину, не восстановив утраченную фонему; для приёмки нужны физические real-mic
matched-component evidence и оценка continuity. Существующие GREEN logs в этом
каталоге сами по себе не означают закрытие physical live gate. После добавления
actual captured fixture-run сохранить его точную команду и отдельный before/after.

### Итоговое ожидание UDP readiness

Проверенный source checkpoint `5e4f7964` (после `d4b81111`) не устанавливает
SO_RCVTIMEO через setsockopt. `UdpSocket::setReceiveTimeoutMs` сохраняет duration;
`receive` сначала вызывает `select`/`hasPendingDatagram(duration)` и обращается
к recvfrom, когда socket отмечен readable. Network worker задаёт 2 мс при
текущих 400 voice packets/s. Готовые datagrams читаются до deadline expiry
для отсутствующей позиции; отсутствие readiness возвращает управление worker.
Это bounded проверка доступности, не добавочный playout buffer или latency.

Native focused proof: `readiness-timeout-final-focused.txt`, в том числе
`udpSocketShortPollingPreservesPacedDatagrams` — 128/128 доставлены при обоих
readiness durations 100 и 2 мс. Независимый Python control в
`socket-timeout-independent-probe.json` измерил SO100=400/400, SO2=397/400,
select2 с SO100 guard=400/400. Это различие локального измерения; финальный
native не использует SO100 guard. Не выдавать control за native configuration
или универсальное утверждение о всякой UDP реализации.

[Microsoft документирует SO_RCVTIMEO как timeout blocking receive](https://learn.microsoft.com/en-us/windows/win32/winsock/sol-socket-socket-options),
а [select как проверку socket readiness](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-select).
Реальное поведение текущего проекта определяется `UdpSocket.cpp`, worker call
и сохранёнными paced-datagram tests. Итоговый runtime прошёл полный CTest 5/5,
459 native tests, 161.61 с (`ctest-final.txt`). Затем test-only commit `5beb7ed1`
усилил captured-fixture assertion до zero missing/longest и ровно 13 cuts;
`strict-observed-replay-green.txt` подтверждает focused rerun, runtime binary не
менялся. Финальный physical gate всё равно подтверждается отдельно.

## Физический повтор после исправления

Требуемое итоговое поведение — общий limit **100 мс**: 20 мс продолжения и 80 мс
плавного затухания. Receive-side и render-side continuation не должны получать
по 100 мс последовательно: output-owned loss run удерживает общий бюджет. После него —
тишина, а не бесконечный pitch loop. Первый актуальный PCM возвращается на своей
timeline position с crossfade до 2.5 мс. Fixed history не является playback
queue; focused final tests подтверждают algorithmic added latency=0 и общий
starvation/queued-loss budget. Provenance tags заранее выделены в том же remote
PCM ring и публикуются вместе с audio; второй audio queue не создаётся. Общий
budget ведёт render-owned continuity, поэтому queued loss и starvation не
получают по независимым 100 мс. Full suite результат сохранён выше. Физический timing и
отсутствие нарастающей queue всё равно требуют полного следующего прогона.

Во всех исходных физических доказательствах активен **Pcm16**. Существующий
Opus encoder настроен на RESTRICTED_LOWDELAY и 2.5 мс packets. Хотя код содержит
`OPUS_SET_INBAND_FEC(1)`, decoder normal decode использует `decode_fec=0`, а
conceal — null payload; FEC-recovery path в этой проверке не используется.
Это согласуется с primary Opus docs: [FEC control описывает SILK redundancy](https://www.opus-codec.org/docs/opus_api-1.5/group__opus__encoderctls.html),
а [RESTRICTED_LOWDELAY отключает voice-optimized modes](https://www.opus-codec.org/docs/opus_api-1.6/group__opus__ctlvalues.html).
Реальные вызовы текущей сборки проверяются по `AudioService/src/network/OpusCodec.cpp`;
при активном Pcm16 Opus/FEC не участвуют в наблюдавшихся cuts.
Новая стратегия не переключает codec, не удлиняет packets и не вводит ожидание
следующего packet ради FEC. Сокращение zero PCM через continuation нельзя
называть восстановлением исходных фонем или результатом FEC.

Повторить V2 в обоих направлениях, на двух физических ПК, с rendered UI evidence
одной песни и теми же ролями/уровнями. Monitoring OFF. Sender network reference
должен оставаться настоящим микрофоном. Receiver master и exact backing — те же
синхронные taps. Никакого time-stretch и снижения NCC >=0.2.

Использовать утверждённые пользователем уникальные 1-second segments внутри
исходных start/middle/end 20-second windows. Strict 20-second result сохранять.
Drift считать только когда все обязательные voiced cells идентифицированы.
Missing voice считать по independently active sender mic и receiver residual,
игнорируя естественные паузы; длительности уточнять в native PCM.

Анализ полного take из корня репозитория (для B заменить label):

```powershell
python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/analyze_real_mic.py artifacts/room-e2e/2026-10-15-direct-late-recovery/final-host-to-laptop-config.json artifacts/room-e2e/2026-10-15-direct-late-recovery/final-host-to-laptop-strict-result.json
python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/diagnose_real_mic_windows.py artifacts/room-e2e/2026-10-15-direct-late-recovery/final-host-to-laptop-config.json artifacts/room-e2e/2026-10-15-direct-late-recovery/final-host-to-laptop-strict-result.json artifacts/room-e2e/2026-10-15-direct-late-recovery/final-host-to-laptop-segmented-result.json 1
```

До запуска заполнить runtime anchors из соответствующего evidence:
songStartRoomFrame = round(playbackStartedAt Unix seconds ×48000), selected
deadline — согласованное server/native значение; senderActiveFromSeconds =
VocalOn UTC − sender StartRecording control UTC +0.5 с guard. Noise reference —
первые 1.5 с тихого настоящего mic. Config с PENDING/NULL anchors не запускать.

Сохранённая final A laptop packet trace содержит восемь раздельных окон по 96
packets, примерно по 240 мс каждое. Последний source extent — song 40.962125 с,
но покрытие НЕ непрерывное. Ни три mandatory failed cells, ни первые три UNKNOWN
38–39 с с окнами не пересекаются. Нельзя приписывать их PLC, retime, late/reorder
или feedback по соседним поздним QUEUE_LATE либо aggregate counters. Точные
границы: `final-host-to-laptop-trace-coverage-limit.json` и `.md`.

Для компактных audible/source clips используется прежний неизменённый
`export_missing_voice_snippets.py`: импортировать модуль, задать `HERE` текущим
каталогом evidence и вызвать `main()` с созданным `*-voice-context-coordinates.json`
и output directory. Все координаты хранить отдельно: receiver native WAV
start/count, sender clock-derived expected frame, event kind и original gate
classification. Нужны master / residual / matched sender real mic, по 0.5 с
контекста с обеих сторон. Source hint вычисляется из actual presentation CSV
минус selected deadline, затем той же effective source CSV mapping. Exporter
применяет только constant local offset при уникальном NCC >=0.2; иначе оставляет
clock hint и UNIDENTIFIED. Добавить SHA-256 каждого clip в manifest. Контекстный
NCC не переклассифицирует missing/UNKNOWN interval и не заменяет timing gate.

Final PASS требует достоверные timing windows, прежний допустимый drift,
отсутствие длинных активных gaps (желательно ни одного >=60 мс), заметное
сокращение longest относительно 92.7/156.6 мс, unchanged deadline policy и
отсутствие накапливающейся очереди. Late cuts указать рядом, отдельно от
PCM missing intervals и субъективной слышимости. Final результат и фактические
before/after измерения добавляются после replay и нового физического прогона.

## Завершённые физические измерения 2026-10-15/16

Native source `5beb7ed1e40b1960d51d5b30ec52c5de1c937983`, runtime SHA-256
`9F1FEBB0CB17B96105BDC0312418BBF2B608DEAC21C67180FBA6B9E548D79BCE`
на обоих ПК. Исходная методика V2, gates, thresholds и deadline policy не менялись.
UI gate обеих полных песен PASS; recording gaps/overruns/stale = 0. Никакой WAV
injection. Тихий mic lead записан до Vocal ON, monitoring OFF.

Итог **physical live gate FAIL**, задача не закрыта. A host→laptop: deadline
57.5 мс (оба native/server 2760 frames); 18/20,19/20,14/14 identified mandatory
cells. Cells song32.000/39.000/73.6079375 имеют NCC .180440/.121593/.179466,
все ниже .2 при unique peaks; clock/coverage этих cells валидны. Поэтому lag,
median и drift A не приняты. 8 UNKNOWN active intervals, total580мс,longest80мс;
zero PCM intervals >=1мс — 0. UNKNOWN не считается подтверждённой тишиной и
не исчезает из gate из-за ненулевого PLC или более сильного NCC широкой clip.

B laptop→host: deadline50мс (оба native/server2400 frames), 20/20,20/20,14/14
identified cells. Accepted start/middle/end/median50.003581/50.124512/50.094076/
50.094076мс, drift+.090495мс. Минимальные mandatory NCC .385804/.328304/.622565.
Classified missing>=60мс =0, UNKNOWN=0, native active zero>=1мс=0 в проверяемой
области. Одна source physical-clock CSV строка WAV2741280,length120frames=2.5мс
невалидна: captureEnd−captureStart=−4frames; она сохранена, не исправлена и не
пересекает mandatory windows. Effective source song65.479104с, ожидаемый receiver
65.529104с. Unchanged whole-song classifier использует effective packet clock:
его MEASURED/0 не доказывает physical-clock coverage этих2.5мс.

B unavailable sender-reference: receiver WAV0..160528frames =3.344333с;
reported song5.053226–8.397559, actual presentation CSV5.074833–8.419104.
Это начало receiver recording до matching sender reference, не post-EOF; вне
mandatory windows. Оно исключено из activity и не считается0dropouts.

Direct cut deltas A+297/B+146 — packet decisions, не число пропавших фонем.
Редкие queue snapshots A1194..2364/B1046..2215frames с first→last2061→1980/
2055→1742 не показывают накопления на концах take, но не являются continuous
maxima. Strict20с NCC также сохранены: A .153926/.186770/.111338; B
.203394/.156077/.191781, strict FAIL обоих. Принятый B timing основан именно
на заранее разрешённом 1с method, а не на ослаблении threshold.

Повтор: команды выше с `final-*-config.json`; inputs/hashes, gzip полных JSON,
compact metrics и минимальные source/master/residual clips перечислены в
`FINAL_EVIDENCE.json`. Подробные результаты — `REPORT.md`. Пользователь отдельно
сообщил «Явных провалов не слышал»; это слуховое наблюдение, не подмена PCM gate.
Cleanup UI/process подтверждён на обоих ПК. Следующая узкая проверка — причина
трёх low-NCC A cells и восьми UNKNOWN, для которых текущий packet trace не
сохранил нужные позиции. Новые timing/runtime изменения в этом gate не делались.
