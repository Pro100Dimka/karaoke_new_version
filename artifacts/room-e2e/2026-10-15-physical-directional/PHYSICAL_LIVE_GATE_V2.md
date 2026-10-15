# Physical live gate v2 — exact real microphone reference

Дополнение к неизменённому `TEST_PLAN.md`, 2026-10-15. Политика room deadline на
`660e8225` не меняется. Этот этап проверяет только физический голос в двух
направлениях; pause/resume/seek, late join и project transfer в него не входят.

**Уточнение приёмки, явно одобренное пользователем 2026-10-15:** «Да, использовать
секундные участки». Внутри тех же трёх 20-секундных окон теперь используются
однозначные совпадения секундных участков; NCC≥0.2 и запрет analysis time-stretch
сохранены. Старый stationary 20s результат хранится отдельно без изменения его
PASS/FAIL. Полная актуальная методика — в разделе «Одобренные секундные участки»
ниже. Исходный `TEST_PLAN.md` остаётся неизменённым.

## Сценарий и конфигурация

Физическая цепочка та же: оригинальный вокал песни действительно играет из
динамика передающего ПК → настоящий микрофон → обычный voice pipeline комнаты →
принимающий ПК → его master с местным минусом и удалённым голосом. WAV-инъекция,
генератор вместо микрофона и мониторинг собственного микрофона не применяются.

Два физических ПК, обычные окна Electron. Host — рабочий ASIO Audient,
48 кГц/64 кадра; ноутбук — Windows, low-latency mic ON, фактический Exclusive input
480 кадров, Shared output. Monitoring OFF. Комната, песня «Мне 25 — Киньте
Копеечку», уровни отправителя/получателя и ограничения на смену конфигурации —
буквально из `TEST_PLAN.md`. Этот тест выполняется на двух ПК, без замены вторым
профилем на одном ПК. Сначала host → laptop, затем laptop → host; при развороте
меняются только уровни и mute микрофона комнаты.

На обоих ПК записать HEAD и состояние diff. Новые taps диагностические: они не
меняют вход, codec, transport, room deadline или PCM конечного выхода.

## Почему меняется reference

Студийный vocal stem и звук реального микрофона — разные сигналы. Динамик,
акустика комнаты, микрофон и его обработка меняют спектр и форму волны. В прошлых
обязательных окнах NCC со studio vocal был ниже установленного 0.2; такие lag не
являлись принятой физической оценкой. Это наблюдение само по себе не доказывает,
что виновата только акустика: неверный канал, tap, вычитание минуса и уровни тоже
должны быть исключены.

Новый основной эталон — точный PCM настоящего микрофона, реально поступающий в
network encoder. Он уже содержит физическую акустическую цепочку и выбранный
input channel. Студийный vocal сохраняется только для одновременного сравнения
старого и нового метода. Он не задаёт абсолютное начало sender WAV.

## Записываемые taps и время

1. Sender: `PrepareRecording ... tap=network`, затем `StartRecording`. WAV mono
   48 кГц содержит `VoicePacketFrames` PCM прямо перед network codec: после выбора
   input channel, capture conversions, DSP, microphone gain, сведения в mono и
   штатного packetization/resampling. Это настоящий микрофон, не diagnostic input.
   Запись именно здесь исключает отличия от существующих `raw`/`processed` taps
   после clock bridge в render callback.
2. Receiver: `PrepareRecording ... tap=master backing=true`, затем `StartRecording`. Это полный
   master до громкости системного endpoint; он содержит local backing + remote
   vocal. Системная громкость и реальное звучание дополнительно проверяются на ПК.
   Одновременно `<master.wav>.backing.wav` содержит точный local backing этого
   render callback после music/song loudness gain, до remote voice. Его формат,
   frame count, очередь записи и индексы совпадают с master; это обязательный
   reference для вычитания. В данном сценарии guide/monitoring выключены.
3. У каждого WAV должен существовать `<wav>.timeline.csv` с колонками:

   ```text
   wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz
   ```

   `wavOffsetFrames`/`frames` — координаты внутри WAV, `sampleRateHz` — частота WAV.
   Все room frame поля имеют частоту `timelineSampleRateHz=48000`.
   Для network `timelineFrame` — действительный эффективный timestamp пакета,
   `captureTimelineFrame`/`captureEndTimelineFrame` — физическое время начала/конца
   исходного capture span **до** acoustic/DSP timestamp compensation. Для master
   `timelineFrame` — presentation time первого PCM frame output callback; capture
   поля нулевые. `roomClockValid=0` не даёт допустимого физического time anchor.
4. По окончании обоих taps вызвать `StopRecording`, сохранить
   `GetRecordingState details=true` и перенести WAV вместе с CSV. Проверить
   `overrunCount`, `gapMetadataDropped`, `staleBlocks`, `gaps`. Ненулевые потери
   самой диагностической записи не выдаются за сетевой dropout или успешный тест.

Старый `startPlaybackPosition` из момента control-команды не является точным
timestamp первого PCM frame. Каждый sample сопоставляется с **собственным CSV
span**, с линейным отображением начала/конца внутри этого span. Разрывы между
физическими spans записываются в результат; глобальное сглаживание времени и
растяжение WAV запрещены. Clock-invalid span в обязательном окне не позволяет
принять физический lag этого окна.

Для quiet reference после запуска sender tap держать у sender Music=0 и Vocal=0
не менее 3 с. Первые 1.5 с sender WAV — реальный фон микрофона. После начала обоих
taps вернуть sender Vocal=100% через UI. Receiver backing играет как обычно.
Зафиксировать время смены уровня; начальный muted участок исключить из покрытия
dropout detector. Это подготовка уровня, физический сценарий всех измерительных
окон остаётся неизменным. Во время пения проверить InputPeak выше фона, без
clipping; не заменять эту проверку увеличением цифрового gain после записи.

## Короткая проверка нового reference перед полными прогонами

Записать ≥25 с физического голоса вместе с sender network tap и receiver master.
На одном и том же receiver residual и окне вывести:

- `studioComparison.absNcc` со старым студийным stem;
- `micAbsNcc`, положение основного пика, `secondPeakNcc`, `peakRatio` с новым tap;
- канал, RMS/peak всех каналов, sample rates, backing gain и NCC.

Порог основного normalized correlation остаётся **0.2**. Дополнительно нужен
однозначный удалённый голос: второй раздельный кандидат вне ±50 мс от главного
пика не должен сам достигать того же 0.2. ±50 мс группируют близкие периодические
подпики одного voiced event, а не снижают установленный confidence threshold.
Повторяющиеся равноценные кандидаты означают ambiguous/FAIL. Сам ratio пиков
публикуется как диагностическое число, отдельного придуманного порога ratio нет.

Если новый mic NCC низок или неоднозначен, полные прогоны не принимаются. Сначала
проверить выбранный канал, совпадение tap с encoder source, DSP/gain, backing
subtraction, полярность, codec/sample-rate. Порог ради PASS не менять.

## Анализ master и удалённого голоса

Используется `../2026-10-15-real-mic-v2/analyze_real_mic.py`; зависимости уже есть в
`python/.venv`: numpy, scipy, soundfile. Читается явный канал, а не среднее всех
каналов, способное погасить anti-phase или разбавить полезный сигнал нулевыми
выходами. По умолчанию канал 0; все channel RMS сохраняются для проверки.

1. Resample обоих WAV и точного rendered backing WAV в 8 кГц. Это одна постоянная
   конверсия sample rate. Никакого dynamic resample или time-stretch анализа.
2. Raw PCM correlation с исходным stem в 4 кГц, затем перевод позиции в 8 кГц
   локализуют позицию песни; они не реконструируют точный render PCM. Точное
   выравнивание `<master.wav>.backing.wav` задано одинаковым frame index из общей
   записи. Проверить одинаковые rate/frame count; gain уже применён в приложении,
   поэтому дополнительный МНК gain для этого reference равен 1.
3. `remoteResidual[i] = master[i] - renderedBacking[i]`. DC удаляется; residual и sender
   mic фильтруются одинаково в 300–3400 Гц. Level normalization выполняется внутри
   NCC. При необходимости допускается другая явно сохранённая постоянная gain,
   но не нелинейная реконструкция сигнала.
4. Для каждой позиции reference вычисляется центрированный нормированный скалярный
   продукт с residual. В знаменателе — энергия **именно соответствующего окна**
   reference и residual. Для допустимой обратной полярности берётся абсолютный
   NCC, signed NCC сохраняется. Максимум уточняется параболой по соседним samples.
5. Поиск sender mic ограничен физическим room anchor (−1 с/+0.25 с около
   ожидаемой позиции), что не позволяет принять совершенно другой кусок песни.
   Для backing и voice отдельно сохраняются peak/floor и confidence.

Обязательные окна исходного плана: начало 20–40 с песни, середина ±10 с от центра,
конец последние 40–20 с. Отсутствующее окно или NCC ниже 0.2 — «voice not found».
Secondary lag при провалившемся окне не публикуется как измерение. Медиана и drift
публикуются только при трёх принятых окнах.

## Координаты lag, backing и drift

Пусть `p` — найденный sender WAV sample, `r` — sample начала соответствующего
receiver master окна, `b` — выровненная позиция local backing. CSV даёт
`C(p)` — физический capture room frame, `E(p)` — эффективный packet room frame,
`R(r)` — receiver presentation room frame. Все три — 48 кГц.

```text
micToRemoteMs = (R(r) - C(p)) / 48
effectiveMusicalLagMs = (R(r) - E(p)) / 48
captureSongSeconds = (C(p) - songStartRoomFrame) / 48000
effectiveVoiceSongSeconds = (E(p) - songStartRoomFrame) / 48000
physicalCaptureToBackingMs = 1000 * (b / analysisRate - captureSongSeconds)
effectiveVoiceToBackingMs = 1000 * (b / analysisRate - effectiveVoiceSongSeconds)
```

`songStartRoomFrame` — authoritative room time позиции песни 0. При playbackRate=1
он вычисляется из сохранённого `playbackStartedAt` минус сохранённая стартовая
`playbackPositionSeconds`, затем переводится в 48 кГц. Не использовать локальное
время получения HTTP/SSH ответа. Сверка `R(r)` с `songStart+b` сохраняется как
`backingPresentationClockOffsetMs`; она показывает согласованность backing и
room clock. Metadata и формула song anchor сохраняются рядом с результатом.

Эти показатели различаются: физический capture→master lag, compensated packet
musical lag и положение timestamped voice относительно местного backing.
Ни один не называется literal studio-vocal-event skew: акустическая задержка
studio→speaker→mic не была независимо уверенно идентифицирована studio NCC.
Совпадение некоторых чисел при нулевой compensation допустимо, но не меняет
определение координат.

Drift — `end micToRemoteMs - start micToRemoteMs`. Порог из исходного плана
сохранён: абсолютное изменение >5 мс означает drift flag. Нельзя заявлять
отсутствие drift, если хотя бы одно обязательное окно не прошло confidence и
timestamp gate. Отдельно сравнить effective/backing coordinates; расхождение
объяснять измеренными anchors, не растяжением сигналов.

## Реальные missing voice intervals

Источник активности — sender real mic. Его room noise измеряется в первых 1.5 с
quiet tap: 95-й перцентиль 20 мс band-passed RMS. Активен frame выше большего из
`medianSinging−35 dB` (исходный план) и `measuredNoise+10 dB`. Дополнительные 10 dB
SNR явно исключают микрофонный фон из «пения»; это не новый NCC threshold. Если
реальный вокал не отделяется от измеренного фона, dropout evidence недостаточен.

Короткий реальный compare-прогон дополнительно установил: 20-секундный residual
после вычитания raw source stem имеет RMS 0.083, при mic RMS 0.027. Backing offset
на отдельных секундах меняется примерно на 0.9 мс; scheduled `MediaSource`
выполняет штатную render resampling/ratio correction. Одно постоянное смещение
сырого 44.1 кГц stem не воспроизводит точный local backing. Поэтому сильный mic
NCC на отдельных секундах (до 0.64) падал до 0.053 на обязательном 20-секундном
окне. Этот прогон **FAIL**; его короткие диагностические lag не принимаются.
Второй этап метода записывает настоящий rendered backing одновременно с master,
вместо растяжения reference в анализаторе. Timing policy не меняется.

После backing subtraction вся запись разбивается на 10-секундные блоки. Каждый
использует один постоянный match offset mic→residual, найденный тем же NCC; при
полностью потерянном блоке берётся ранее измеренное соответствие из принятых
окон. Сигнал не time-stretch-ится. Внутри — frames по 20 мс; matched projection
на real-mic waveform отделяет нужный голос от случайной энергии residual/backing.
Каждый frame дополнительно проверяет постоянные offsets ±5 мс: малый packet-grid
retime не должен объявляться пропаданием из-за фазового сдвига. Это локальное
выравнивание формы, не изменение её скорости; fixture с непрерывным голосом и
±1.75 мс скачками должен давать ноль пропаданий.
Естественные паузы и начальный muted участок не считаются пропаданием.

Missing — активный sender frame с matched voice component ниже −30 dB от
нормального коэффициента передачи удалённого голоса. Нормальный коэффициент —
медиана локальных gains frames с NCC≥0.2; сохраняются p10/p50/p90 и отдельно
исходный 20-секундный projection gain. Это не даёт фазовым перемещениям снизить
baseline уровня (fixture ±1.75 мс воспроизводит ошибочное снижение 1.0→0.5).
Соседние missing frames
объединяются, событие принимается начиная с 60 мс. Сохраняются начало/длительность
каждого, count, longest, total missing duration, sender active coverage и noise
floor. При слабом выделении residual или невалидной записи результат не заменяется
нулевым dropout count. Сохранить короткие прослушиваемые фрагменты вокруг каждого
обнаруженного события, чтобы отличить действительно слышимую потерю от артефакта
анализа. Сильный residual с NCC<0.2 и ненизкой matched amplitude обозначается
`unidentified`, а не доказанным отсутствием: такие интервалы ≥60 мс дают
`INDETERMINATE`/FAIL dropout confidence gate. Ноль при недостаточной идентификации
не является успешным результатом. Цифровое отсутствие и субъективная слышимость
описываются отдельно.

Для точных границ используется **native PCM** master−paired backing до любых
resample/bandpass анализа. Цифровая тишина ограничена двумя PCM16 LSB
(`2/32768`): это верхняя граница погрешности двух независимо квантованных WAV,
а не пониженный voice confidence threshold. Непрерывный такой участок ≥60 мс
считается missing только там, где выровненный real-mic reference активен.
Разрешение границ при 48 кГц — 1/48 мс. Начальный muted участок и естественные
паузы исключаются activity mask. Native interval уточняет границы matched-loss
кандидата, не полагаясь на сетевой counter. Projection loss без соответствующей
native silence сохраняется отдельно как unresolved и не даёт успешный ноль.

Так устранена проверенная ошибка старого detector: при onset вне 20-мс сетки
реальный 60-мс dropout давал только два полностью пустых 20-мс frames и ошибочный
ноль. Синтетический dedicated RED воспроизвёл её; native detector проверен на
невыравненных 60/100/220 мс потерях и естественных паузах. Дополнительно на копии
реального `compare3` residual известные вставки 60/100/220 мс дали ровно
60/100/220 мс, с сохранением основного NCC gate. Это offline-калибровка измерения,
не физическая инъекция и не изменение исходных WAV.

`RemoteLateAudioCuts` — дополнительный counter пакетов, а не число пропаданий.
Для каждого направления сохранить before/after **активного** прогона и временной
ряд обоих AudioService каждые 5–15 с, включая nonzero/empty/other cut counters.
Сопоставлять рост counters с потерями sender-active интервалов, длительностями и
PCM. Старые +1445 без старого sender reference нельзя ретроспективно точно
разделить на слышимые/неслышимые; новый прогон должен показать эту связь прямо.

## Повторяемый запуск анализатора

Скопировать с ноутбука его WAV, CSV и recording metadata в каталог прогона.
Сохранить точные stems, загруженные AudioService (`LoadSong`), либо их абсолютные
пути/хеши. Пример config (значение songStartRoomFrame берётся из room snapshot):

```json
{
  "receiverMaster": "run-receiver-master.wav",
  "renderedBacking": "run-receiver-master.wav.backing.wav",
  "senderMic": "run-sender-mic.wav",
  "backing": "D:/.../instrumental.wav",
  "studioVocal": "D:/.../vocals.wav",
  "receiverMasterChannel": 0,
  "backingChannel": 0,
  "senderMicChannel": 0,
  "songStartRoomFrame": 0,
  "roomRate": 48000,
  "senderNoiseSeconds": [0, 1.5],
  "senderActiveFromSeconds": 3,
  "shortComparison": false
}
```

```powershell
& python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/test_analyze_real_mic.py
& python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/analyze_real_mic.py <run-config.json> <run-result.json>
& python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/validate_actual_detector.py <run-config.json> <run-result.json> <known-loss-validation.json>
```

Для короткого сравнения установить `shortComparison=true`; этот результат не
заменяет три окна полного прогона. Прогон каждого направления длится до конца
песни. Screenshots показывают оба настоящих окна, их уровни/mutes и live-state;
JSONL содержит backend, rate, period/buffer, capture/clock bridge counters, RTT,
jitter, target/queue, alignment, source/history diagnostics и выбранный deadline.

Проверка считается физически пригодной только после однозначной идентификации
реального голоса обоих направлений, всех трёх lag, допустимого drift и анализа
реальных missing intervals. Автотесты анализатора проверяют математику, не
подменяют физическое измерение. По окончании вернуть уровни по исходному плану,
выйти из комнаты, закрыть оба приложения и проверить отсутствие принадлежащих
им Electron/Python/AudioService процессов. Итоговый REPORT должен явно сообщить
PASS/FAIL, оба направления, NCC, timestamps, deadline, cuts, dropouts и ограничения.

## Одобренные секундные участки — актуальная приёмка

Пользователю были показаны оба физических направления и ограничение длинной
корреляции: существующий receiver queue retime преобразует 120 samples в 117/123
при малой ошибке очереди. Это меняет фазу внутри длинного окна, хотя короткие
участки уверенно идентифицируются. Пользователь прямо одобрил секунды после
предложения сохранить исходные начало/середину/конец, NCC≥0.2 и отсутствие
растяжения. Это изменение **анализа**, не room timing policy. Strict 20s JSON
сохраняется отдельно; его FAIL не переписывается на PASS.

1. Каждое исходное 20s окно делится на постоянные участки по 1 с. Сигнал не
   растягивается; для каждого участка находится одно постоянное смещение в
   real-mic WAV. Основной NCC должен быть ≥0.2; второй отдельный пик за ±50 мс
   не должен сам достигать 0.2. Минимальный/медианный NCC и coverage сохраняются.
2. При неуникальном 1s совпадении допускается контекст 2, затем 3 с внутри того
   же исходного окна. Сам контекст должен пройти **тот же** NCC≥0.2 и unique
   peak gate. Он выбирает правильное вхождение; целевой 1s участок повторно
   проверяется с NCC≥0.2 около найденного вхождения (постоянный search ±5 мс).
   Нет ослабления ratio/secondary threshold. Неидентифицированное время явно
   остаётся unknown; оно не исключается ради улучшения coverage.
3. Активность sender определяется независимо от найденного correlation peak:
   receiver presentation room time минус **выбранный до песни** deadline даёт
   ожидаемый эффективный packet stamp. CSV отображает его в реальный sender WAV.
   Эта координата используется только для activity/search; измеренный lag всё
   равно получается из независимого waveform match и физических C/R timestamps.
   Плохой peak в тихом месте не может спрятать настоящий активный голос.
4. Требуется учёт всех voiced cells трёх окон; никакой новый допускающий процент
   пропусков не установлен. Внефайловые/clock-invalid обязательные cells дают FAIL,
   даже если случайно помечены тихими. Источник вне CSV/WAV coverage считается
   unavailable, не прижимается к первому/последнему sample через interpolation.
5. Start/middle/end lag — медиана принятых секундных lag соответствующего окна.
   Общий median — медиана этих трёх медиан. Drift — end−start, прежний порог >5 мс
   сохранён. Отдельно сообщить effective timestamp voice относительно точной
   local backing позиции, найденной по companion/source; сохранить его coverage.

Для **всей песни**, а не только трёх окон, те же 1s matches (с 2/3s контекстом)
связывают real mic и receiver residual. Каждый отрезок использует постоянное
смещение, без time-stretch. Затем применяется 20ms matched-component detector:

Вне трёх обязательных окон повторяющаяся гласная может иметь два сильных
1s-кандидата и при этом непрерывно звучать. Для **presence**, но не для timing,
такой участок проверяется около независимой packet-clock координаты в пределах
±25 мс (половина уже принятого 50ms разделения разных пиков). Этот кандидат
обязан сохранить NCC≥0.2, затем пройти те же 20ms component/gain проверки ниже.
То же clock-local ограничение применяется к presence даже при уникальном
широком match: точное совпадение старого/повторённого голоса на 250 мс раньше
не доказывает наличие текущего packet. Такое расхождение даёт unknown, а не
автоматическую потерю, и сохраняется как `globalMatchMinusClockMs`.
В JSON остаются исходные ambiguity/second peak и отдельный признак
`clockAnchoredPresence`. Дальнее похожее вхождение не выбирается ради высокого
NCC. Низкий NCC, неверный component или недоступный reference остаются unknown.
Обязательные start/middle/end lag по-прежнему требуют unique peak; clock-local
presence не даёт права вычислять из неоднозначной секунды lag или drift.

- источник активен по независимому packet-clock mapping и измеренному noise gate;
- source waveform должен присутствовать с NCC≥0.2; ищется только постоянный
  локальный сдвиг ±5 мс, чтобы малый retime не стал ложным missing;
- matched gain ниже −30 dB от медианного нормального local gain означает потерю/
  сильное ослабление, даже если residual ненулевой и NCC остаётся высоким;
- ненулевая PLC/шумовая энергия без правильной source waveform не доказывает
  присутствие голоса: такой ≥60ms участок даёт INDETERMINATE/FAIL;
- native master−backing уточняет точные границы цифровой тишины ≤2 PCM16 LSB.
  Это только часть missing detector, не замена waveform/−30dB проверок.

Сохраняются все sender-active native gaps ≥1 мс: список, count, longest, total.
Порог 1 мс — удобная граница инженерной сводки, **не** порог слышимости. Отдельно
остаются исходные события ≥60 мс. Короткие sample-scale нули/zero crossings
сохраняются в histogram и не называются сетевыми пропаданиями. Ноль событий
≥60 мс не означает ноль потерянного голоса. Для слышимости слушать сохранённые
master/residual/real-mic snippets; счётчики её не доказывают.

Config дополняется полями:

```json
{
  "approvedOneSecondGate": true,
  "selectedDeadlineMs": 80
}
```

Число deadline берётся из **этого** активного прогона, не из примера и не из
post-song conversation delay. Команды:

```powershell
& python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/analyze_real_mic.py <run-config.json> <strict-20s-result.json>
& python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/diagnose_real_mic_windows.py <run-config.json> <strict-20s-result.json> <segmented-result.json> 1
```

Несмотря на историческое имя `diagnose_*`, при `approvedOneSecondGate=true`
результат имеет `USER_APPROVED_1S`, отдельно содержит strict status, coverage,
physical lag, backing lag, drift, whole-song matched presence и native gaps.
Файл без этого флага остаётся только диагностическим и не меняет приёмку.

Чистая repeatability проверяется на двух одновременно открытых karaoke views:
до Play, во время песни и в конце сохраняются DOM/URL и screenshots **обоих**
окон. Library/другая страница на одном ПК не заменяется предположением, что звук
продолжал идти: такой physical UI gate не принимается, прогон повторяется.

## Операционный порядок на двух ПК

| | Основной ПК (host) | Ноутбук |
|---|---|---|
| Repo | `D:\Git\karaoke_new_version` | `C:\Users\pro10\Documents\karaoke_new_version` |
| Доступ | рабочий desktop | `ssh pro10@192.168.0.194`, его активный desktop |
| Запуск | обычный `start.bat` в repo | обычный `start.bat` в repo |
| Устройство | Audient USB Audio ASIO Driver | системные Windows input/output |
| Режим | ASIO, 48 кГц/64 | Exclusive input 480, Shared output, low-latency mic ON |

1. На обоих ПК сверить `git rev-parse HEAD`, сохранить `git status --short`; ничего
   не сбрасывать. Release собрать `cmake --build AudioService/build --config Release`.
   Запустить обычное приложение на **каждом физическом desktop** через его
   `start.bat`. Проверить видимые окна обоих ПК; два локальных профиля не заменяют
   ноутбук. Записать фактические устройства и режимы, monitoring выключить.
2. В UI host открыть «Онлайн-комната» → «Создать комнату». На ноутбуке «Войти в
   комнату», ввести код. Проверить connected/ready двух участников. На host в
   библиотеке выбрать «Мне 25 — Киньте Копеечку», дождаться открытой консоли обоих
   окон и общего Playing. Если нужен отдельный старт — использовать кнопку Play
   в UI. Не вызывать room playback API вместо действий в окнах.
3. В консоли выставить роли, затем запустить диагностические taps ниже. Первые
   ≥3 с sender tap оставить Vocal=0 для quiet reference, затем через UI Vocal=1.
   Сохранить screenshot и точное время этого действия. Приёмник всё время играет
   local backing. Ни драйверы, ни периоды, ни route между направлениями не менять.
   Оба tap должны уже писать до 20-й секунды песни, а Vocal должен быть включён
   до начала окна 20–40 с. Если UI/подготовка заняли дольше, повторить обычный
   старт; неполный первый cell не исключать из приёмки.
   Перед quiet tap дождаться завершения UI-команд и прочитать фактические роли:
   sender Music=0/Vocal=0, receiver Music=1/Vocal=0. Включённая sender backing
   загрязняет quiet reference; такой прогон не принимается для dropout coverage.

| Ручка / mute | Sender во время вокала | Receiver |
|---|---:|---:|
| Музыка | 0% | 100% |
| Вокал оригинала | 100% (первые ≥3 с tap — 0%) | 0% |
| Микрофон gain | 100% | 100% |
| Удалённый голос gain | 100% | 100% |
| Микрофон комнаты | ON | OFF |
| Monitoring | OFF | OFF |

Host PowerShell, пример sender tap (папку создать заранее):

```powershell
$env:AD_VOICE_AUDIO_ENDPOINT = '\\.\pipe\ADVoice.AudioService.Dev.v1'
$audioControl = 'D:\Git\karaoke_new_version\AudioService\build\Release\AudioControl.exe'
& $audioControl StopRecording
& $audioControl PrepareRecording id=physical-h2l-network path=D:\Git\karaoke_new_version\artifacts\room-e2e\2026-10-15-real-mic-v2\h2l-sender-mic.wav tap=network
& $audioControl StartRecording
```

На ноутбуке `ac.bat` — существующий wrapper для его Release AudioControl с тем же
`AD_VOICE_AUDIO_ENDPOINT`. Важно убедиться, что wrapper указывает на текущий repo
и текущий Release. Пример receiver tap с точным backing companion:

```powershell
ssh pro10@192.168.0.194 'ac.bat StopRecording'
ssh pro10@192.168.0.194 'ac.bat PrepareRecording id=physical-h2l-master path=C:\Users\pro10\h2l-receiver-master.wav tap=master backing=true'
ssh pro10@192.168.0.194 'ac.bat StartRecording'
```

Для laptop→host поменять роли: на ноутбуке `tap=network`, на host
`tap=master backing=true`; id и имена WAV отличные (`l2h-*`). Короткий compare
записывается ≥45 с, полные прогоны — до конца песни, чтобы присутствовали все три
окна исходного плана. Используется та же комната и та же песня; выбор/новый Play
выполняется в UI. Receiver microphone комнаты всегда OFF.

Диагностика и финализация (оба ПК):

```powershell
& $audioControl GetDiagnostics
ssh pro10@192.168.0.194 'ac.bat GetDiagnostics'
& $audioControl StopRecording
& $audioControl GetRecordingState details=true
ssh pro10@192.168.0.194 'ac.bat StopRecording'
ssh pro10@192.168.0.194 'ac.bat GetRecordingState details=true'
```

Ответы сохранять с UTC timestamp, `GetDiagnostics` повторять через 5–15 с на обоих
ПК. `GetRecordingState` должен подтвердить финализацию и отсутствие recording
overrun/gaps. После закрытия WAV скопировать с ноутбука соответствующие `.wav`,
`.wav.timeline.csv` и `.wav.backing.wav` в каталог прогона через `scp`. CSV master
применяется также к его companion.

Сохранить сырой read-only `GET http://130.61.169.61:8081/rooms/<roomId>` во время
Playing: `playbackStartedAt`, `playbackPositionSeconds`, `playbackRate`,
`serverNow`, `roomPlayoutDelayMs`, `roomTimingSource`, `participants.voiceLatencyMs`.
`songStartRoomFrame` вычислять с точностью исходного ISO timestamp, сохраняя его
доли миллисекунды; Python `datetime.fromisoformat(...).timestamp()*48000`
достаточен. Этот GET служит только наблюдением, не управлением тестом.

Точные source stems взять из фактической команды `LoadSong`/revision песни.
Для этой песни на host они находились в
`C:\Users\YOJIK\AppData\Roaming\AD Voice Dev\backend-data\songs\252c8e32-5654-48fd-b64b-09d2cac55640\revisions\2\audio\`:
`instrumental.wav` и `reference-vocal.wav`. Проверить актуальность revision и
хеши при повторении, а не выбирать файл только по имени. Основной subtraction
reference всё равно записанный companion, studio stem только сравнение.

После изменения Vocal из quiet→active сохранить actual sender WAV координату;
в config `senderActiveFromSeconds` поставить безопасную границу после перехода.
Не объявлять начальную намеренную тишину сетевым пропаданием. В итоговом отчёте
указать покрытие sender-active аудио, обеих сторон timestamps/counters, точные
config/result/WAV/CSV пути и результаты offline-калибровки detector на известных
60/100/220 мс потерях **копии** residual. Эти искусственные offline маски не
заменяют ни одну физическую запись и никогда не отправляются в приложение.

## Автоматизация обычных UI действий при повторе

Когда оба физических приложения уже запущены, подключены к одной комнате и
находятся в библиотеке, существующий CDP helper может выполнить тот же сценарий:

```powershell
node artifacts/room-e2e/2026-10-15-real-mic-v2/capture-run.mjs <room-code> host-to-laptop <unique-label-A> 165 start
node artifacts/room-e2e/2026-10-15-real-mic-v2/capture-run.mjs <room-code> laptop-to-host <unique-label-B> 165 start
```

Host CDP: localhost:9351; ноутбук CDP: localhost:9352 через SSH forwarding на
его localhost:9351. Script использует обычные rendered UI кнопки песни и ручки,
а не playback API. Если после первого прогона одна страница ещё в караоке,
вернуться в библиотеку обычной кнопкой перед вторым вызовом; не ждать отсутствующую
карточку песни. Отдельный `start` mode дожидается завершения обоих UI level
действий и settled native recording state, затем проверяет реальные роли и
Music/Vocal=0 у отправителя **до** открытия diagnostic tap. Незавершённый child
process команды уровней нельзя считать завершённым только по получению session ID.

Далее первые ≥3 с mic tap тихие, Vocal=1 включается через UI. До 20 с позиции
песни должны уже существовать оба WAV и активный физический вокал. URLs, уровни,
mute/monitoring и native диагностика записываются примерно каждые 5 с, screenshots
обоих окон — каждые 30 с. Любое расхождение страниц/уровней во время оригинальной
песни приводит к отказу этого UI прогона. Файлы с ноутбука копируются только после
финализации. Новый label обязателен: не перезаписывать уже сохранённый прогон.
