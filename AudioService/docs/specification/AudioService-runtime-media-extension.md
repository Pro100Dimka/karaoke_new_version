**# Дополнение к существующему AudioService**
\> **\*\*Фаза II — будущие runtime media возможности.\*\*** Этот документ сохраняет
\> требования пользователя к AudioService после завершения [основного плана]\(AudioService-implementation-plan.md)
\> и его [этапов 0–18]\(AudioService-stages.md). Он описывает целевое состояние,
\> а не утверждает, что перечисленные возможности уже реализованы. Текущий
\> статус проекта ведётся только в [файле прогресса]\(AudioService-progress.md).
\> Порядок небольших проверяемых результатов для этой фазы находится в
\> [плане этапов фазы II]\(AudioService-runtime-media-stages.md).
Требования ниже дополняют существующие Recording, Analysis, Network, DSP,
recovery и configuration. Их реализации следует **\*\*расширять\*\***, сохраняя одну
ответственность и один актуальный путь; параллельные audio engine, recorder,
network stack или player не создаются. Во всех пунктах продолжают действовать
[правила проекта]\(../AGENTS.md), включая измерение влияния на monitoring,
bounded память и отсутствие блокировок и I/O в realtime потоке.
**## 1. Исходная точка**
Предполагается, что AudioService уже реализует ранее описанные возможности:
\`\`\`text
WASAPI Shared
WASAPI Exclusive
ASIO
Input / Output devices
Realtime Capture
Realtime Render
Monitoring
Mixer
DSP
Resampling
Clock Synchronization
Drift Correction
Recording Consumer
Network Audio
Remote Voices
Diagnostics
Recovery
Reconfiguration
Sleep / Resume
\`\`\`
Эти части повторно не проектируются.
Настоящее дополнение расширяет уже существующий AudioService следующими runtime-возможностями:
\`\`\`text
Song Playback
Transport
Music Source ownership
Recording lifecycle
Live signal analysis
Editor audio preview
Radio playback
Remote media session
Unified runtime position
Media diagnostics
\`\`\`
**---**
**# 2. AudioService становится владельцем всего live media playback**
AudioService должен быть единственным компонентом приложения, который непосредственно воспроизводит звук пользователю.
К нему относятся:
\`\`\`text
Karaoke instrumental
Optional vocal/reference track
Microphone
Monitoring
Remote voices
Editor preview
Radio
Recording playback preview
\`\`\`
Все эти источники поступают в уже существующий Mixer.
Главный путь:
\`\`\`text
Media Sources
      │
      ├── Music
      ├── Microphone
      ├── Remote Voices
      ├── Editor Preview
      └── Radio
             ↓
           Mixer
             ↓
      Master Processing
             ↓
          Output
\`\`\`
**---**
**# 3. Song Playback**
Добавить полноценное управление воспроизведением подготовленной песни.
AudioService получает audio resources песни.
Например:
\`\`\`text
instrumental.flac
\`\`\`
и при необходимости:
\`\`\`text
vocals.flac
\`\`\`
AudioService не занимается созданием этих файлов.
Он только использует готовые audio resources для runtime playback.
**---**
**# 4. LoadSong**
Перед началом Karaoke вызывается:
\`\`\`text
LoadSong
\`\`\`
Передаются как минимум:
\`\`\`text
songId
instrumentalPath
optional vocalsPath
duration
session playback options
\`\`\`
AudioService:
\`\`\`text
проверяет доступность файла
↓
открывает decoder
↓
читает format
↓
подготавливает MediaSource
↓
подготавливает resampler при необходимости
↓
подготавливает bounded decode buffer
↓
переходит в Ready
\`\`\`
**---**
**# 5. Audio decoding**
Декодирование музыкального файла не выполняется в realtime callback.
Путь:
\`\`\`text
Audio File
↓
Decoder Worker
↓
Bounded PCM Buffer
↓
MusicSource
↓
Realtime Mixer
\`\`\`
Realtime thread только забирает уже подготовленные PCM frames.
**---**
**# 6. Decoder не может блокировать realtime**
Если decoder временно не успел:
\`\`\`text
Realtime Thread
НЕ ЖДЁТ
\`\`\`
Создаётся:
\`\`\`text
MusicUnderrun
\`\`\`
и применяется определённая underrun policy.
Обычно:
\`\`\`text
silence
\`\`\`
до восстановления source.
**---**
**# 7. Playback State**
У AudioService появляется отдельное runtime-состояние playback:
\`\`\`text
Empty
Loading
Ready
Playing
Paused
Stopping
Finished
Failed
\`\`\`
Оно не заменяет:
\`\`\`text
SessionState
\`\`\`
Это состояние именно загруженной media source.
**---**
**# 8. Play**
Команда:
\`\`\`text
Play
\`\`\`
запускает playback с текущей authoritative position.
Если position:
\`\`\`text
0
\`\`\`
воспроизведение начинается с начала.
**---**
**# 9. Pause**
Команда:
\`\`\`text
Pause
\`\`\`
останавливает продвижение playback timeline.
AudioSession при этом может продолжать работать.
То есть:
\`\`\`text
Input Capture
Monitoring
Remote Voice
\`\`\`
могут оставаться активными.
**---**
**# 10. Resume**
\`\`\`text
Resume
\`\`\`
продолжает playback с сохранённой позиции.
Не создаётся новая session без необходимости.
**---**
**# 11. Stop**
\`\`\`text
Stop
\`\`\`
останавливает текущую песню и возвращает playback position в определённое начальное состояние.
Например:
\`\`\`text
position = 0
PlaybackState = Ready
\`\`\`
AudioSession может остаться открытой.
**---**
**# 12. Seek**
AudioService реализует:
\`\`\`text
Seek(targetFrame)
\`\`\`
или эквивалентную позицию.
Seek должен:
\`\`\`text
остановить использование старых decoded frames
↓
инвалидировать старый source buffer
↓
переместить decoder
↓
подготовить PCM новой позиции
↓
обновить playback mapping
↓
продолжить с новой позиции
\`\`\`
Старый PCM после seek воспроизводиться не должен.
**---**
**# 13. Authoritative playback position**
Единственным источником фактической позиции песни является AudioService.
Не frontend timer.
Не приблизительный wall clock.
Позиция вычисляется относительно:
\`\`\`text
Render Timeline
\+
Playback Mapping
\`\`\`
AudioService предоставляет:
\`\`\`text
PlaybackPositionFrames
\`\`\`
и производное:
\`\`\`text
PlaybackPositionSeconds
\`\`\`
**---**
**# 14. Karaoke synchronization**
Текст, ноты и визуальные элементы Karaoke используют позицию AudioService.
Путь:
\`\`\`text
AudioService Render Position
↓
Playback Position
↓
UI Position Snapshot
↓
Lyrics
Piano Roll
Live Pitch Visualization
Video
\`\`\`
AudioService остаётся authoritative source времени.
**---**
**# 15. Position updates для UI**
AudioService не обязан отправлять событие на каждый audio callback.
Для UI публикуется контролируемый snapshot.
Например:
\`\`\`text
30–60 updates/sec
\`\`\`
Frontend может визуально интерполировать между snapshots.
Но authoritative position остаётся в AudioService.
**---**
**# 16. End Of File**
При достижении конца песни:
\`\`\`text
PlaybackState = Finished
\`\`\`
AudioService фиксирует точную финальную позицию.
Генерируется:
\`\`\`text
PlaybackFinished
\`\`\`
Если recording привязана к Karaoke session, применяется определённая recording completion policy.
**---**
**# 17. Playback Rate**
AudioService поддерживает runtime playback-rate изменения:
\`\`\`text
0.50
0.65
0.75
0.85
1.00
\`\`\`
Изменение rate не должно требовать открытия нового output stream.
**---**
**# 18. Playback Rate и timeline**
При изменении speed:
\`\`\`text
source timeline
\`\`\`
и:
\`\`\`text
render timeline
\`\`\`
остаются корректно сопоставлены.
UI получает фактическую playback position уже с учётом выбранной скорости.
**---**
**# 19. Key Transpose**
AudioService поддерживает runtime transpose:
\`\`\`text
-12 ... +12 semitones
\`\`\`
Если транспонирование применяется к accompaniment, оно реализуется как часть media processing path.
Любая algorithmic latency pitch-processing учитывается в:
\`\`\`text
LatencyRegistry
\`\`\`
**---**
**# 20. Music volume**
MusicSource имеет отдельный:
\`\`\`text
MusicGain
\`\`\`
Он изменяется realtime без restart stream.
**---**
**# 21. Optional vocal/reference source**
Если приложению требуется воспроизведение reference vocal:
\`\`\`text
vocals.flac
\`\`\`
он загружается как отдельный source.
Например:
\`\`\`text
InstrumentalSource
ReferenceVocalSource
\`\`\`
Каждый имеет отдельные:
\`\`\`text
Gain
Mute
Routing
\`\`\`
**---**
**# 22. Все song sources используют одну timeline**
Нельзя запускать instrumental и reference vocal двумя независимыми player.
Они используют:
\`\`\`text
одну Playback Timeline
\`\`\`
Поэтому:
\`\`\`text
Play
Pause
Seek
Rate
Stop
\`\`\`
синхронно применяются ко всем связанным tracks.
**---**
**# 23. Recording lifecycle полностью принадлежит AudioService**
Существующий Recording Consumer расширяется до полноценной Recording Session.
AudioService реализует:
\`\`\`text
PrepareRecording
StartRecording
PauseRecording
ResumeRecording
StopRecording
FinalizeRecording
\`\`\`
**---**
**# 24. PrepareRecording**
До начала записи создаются:
\`\`\`text
RecordingSession
Target File
Audio Format
Recording Queue
Writer
Metadata
\`\`\`
До realtime start.
**---**
**# 25. Recording Tap**
Recording может получать один из существующих taps:
\`\`\`text
RawInput
CleanVoice
ProcessedVoice
MasterMix
\`\`\`
**---**
**# 26. StartRecording**
При старте фиксируются:
\`\`\`text
RecordingId
generationId
recordingStartSessionFrame
playbackPosition
timestamp
sampleRate
channelCount
selectedTap
\`\`\`
**---**
**# 27. PauseRecording**
Pause Recording не останавливает AudioSession.
Recording перестаёт сохранять новые recording frames согласно определённой pause policy.
**---**
**# 28. ResumeRecording**
Recording продолжает работу внутри той же RecordingSession.
Pause intervals должны быть известны metadata.
**---**
**# 29. StopRecording**
При Stop:
\`\`\`text
recordingStopSessionFrame
\`\`\`
фиксируется немедленно.
Realtime больше не отправляет новые blocks этой recording session.
**---**
**# 30. Recording Finalization**
Writer:
\`\`\`text
дописывает уже полученные blocks
↓
записывает metadata
↓
закрывает файл
↓
валидирует результат
\`\`\`
После этого AudioService возвращает:
\`\`\`text
RecordingResult
\`\`\`
**---**
**# 31. RecordingResult**
Минимально содержит:
\`\`\`text
recordingId
filePath
durationFrames
durationSeconds
sampleRate
channels
selectedTap
startSessionFrame
stopSessionFrame
startPlaybackPosition
gaps
overrunCount
finalizationStatus
\`\`\`
**---**
**# 32. Recording не зависит от Monitoring**
Допустимо:
\`\`\`text
Monitoring OFF
Recording ON
\`\`\`
**---**
**# 33. Recording не зависит от Music**
Допустима запись:
\`\`\`text
microphone only
\`\`\`
без активной песни.
**---**
**# 34. Recording и Playback synchronization**
Если запись идёт во время Karaoke, AudioService знает точное соответствие:
\`\`\`text
Recording Frame
↔
SessionFrame
↔
Playback Position
\`\`\`
Это позволяет позже точно сопоставлять исполнение с песней.
**---**
**# 35. Recording gaps**
Если realtime recording queue переполнилась:
\`\`\`text
RecordingOverrun
\`\`\`
и сохраняются:
\`\`\`text
GapMetadata
\`\`\`
Никакой тихой потери PCM.
**---**
**# 36. Recording file writer**
Disk I/O остаётся вне realtime thread.
\`\`\`text
Realtime
↓
RecordingQueue
↓
RecordingWorker
↓
File
\`\`\`
**---**
**# 37. Live Signal Analysis**
AudioService уже получает microphone PCM.
Поэтому добавить realtime lightweight signal metrics.
Они вычисляются без отдельного открытия устройства.
**---**
**# 38. Input Level**
AudioService рассчитывает:
\`\`\`text
Peak
RMS
\`\`\`
для текущего microphone input.
**---**
**# 39. Signal Presence**
Определяется:
\`\`\`text
SignalPresent
\`\`\`
по заданной измерительной policy.
Это используется для UI:
\`\`\`text
микрофон работает / сигнала нет
\`\`\`
**---**
**# 40. Clipping**
Определяется:
\`\`\`text
Clipping
\`\`\`
и:
\`\`\`text
ClipCount
\`\`\`
**---**
**# 41. Noise / silence metrics**
AudioService может предоставлять lightweight:
\`\`\`text
NoiseFloorEstimate
SilenceState
\`\`\`
если это возможно без тяжёлой offline analysis.
**---**
**# 42. Live metrics не являются AI-анализом**
AudioService не выполняет здесь:
\`\`\`text
performance scoring
pitch accuracy report
section analysis
\`\`\`
Это не часть данного дополнения.
Live signal analysis существует только для:
\`\`\`text
monitoring
diagnostics
UI meter
device testing
\`\`\`
**---**
**# 43. Live Pitch**
Если AudioService уже имеет realtime pitch detection для Karaoke, результат публикуется как runtime metric:
\`\`\`text
frequencyHz
midiNote
confidence
sessionFrame
\`\`\`
**---**
**# 44. Device Test Input**
Добавить explicit command:
\`\`\`text
TestInput
\`\`\`
который позволяет UI проверить выбранный microphone.
AudioService возвращает live:
\`\`\`text
Peak
RMS
SignalPresent
Clipping
\`\`\`
**---**
**# 45. Device Test Output**
Добавить:
\`\`\`text
TestOutput
\`\`\`
AudioService воспроизводит заранее определённый короткий test signal через выбранный output.
Он проходит через нормальный output backend.
**---**
**# 46. TestOutput не требует Karaoke session**
Output device можно проверить из Settings.
**---**
**# 47. Melody Editor Preview**
AudioService получает дополнительный runtime use-case:
\`\`\`text
Editor Preview
\`\`\`
Не создаётся отдельный audio engine.
Используется существующий playback subsystem.
**---**
**# 48. LoadPreview**
Melody Editor может передать:
\`\`\`text
audioPath
startPosition
optional endPosition
\`\`\`
AudioService подготавливает preview source.
**---**
**# 49. Editor Preview commands**
Минимум:
\`\`\`text
PreviewPlay
PreviewPause
PreviewStop
PreviewSeek
SetPreviewLoop
\`\`\`
**---**
**# 50. Preview Loop**
Для выбранного диапазона:
\`\`\`text
startFrame
endFrame
\`\`\`
можно включить циклическое воспроизведение.
На границе loop AudioService обеспечивает корректное новое mapping без воспроизведения stale PCM.
**---**
**# 51. Editor playhead**
Playhead Melody Editor использует authoritative preview position AudioService.
**---**
**# 52. Audition tone**
Если Editor должен проигрывать отдельную ноту, AudioService может иметь:
\`\`\`text
PlayReferenceTone
\`\`\`
с параметрами:
\`\`\`text
MIDI note
duration
gain
\`\`\`
**---**
**# 53. Reference tone не создаёт новый output path**
Он является ещё одним временным Mixer Source.
**---**
**# 54. Radio Playback**
Radio также становится обычным media source AudioService.
Не создаётся отдельный player.
**---**
**# 55. Radio Source**
Путь:
\`\`\`text
Network Radio Stream
↓
Radio Worker
↓
Decoder
↓
Bounded PCM Buffer
↓
RadioSource
↓
Mixer
\`\`\`
**---**
**# 56. Radio commands**
Минимум:
\`\`\`text
LoadRadioStation
PlayRadio
PauseRadio
StopRadio
SetRadioGain
\`\`\`
**---**
**# 57. Radio network stall**
Если radio stream временно не получает данные:
Realtime thread не ждёт.
Применяется:
\`\`\`text
silence
\+
RadioBuffering diagnostic
\`\`\`
**---**
**# 58. Karaoke имеет приоритет над Radio**
При старте Karaoke radio:
\`\`\`text
останавливается
\`\`\`
или переводится в определённое состояние до начала Karaoke playback.
Не должно одновременно случайно звучать:
\`\`\`text
Radio + Karaoke
\`\`\`
**---**
**# 59. Remote Media Session**
Существующий Network Consumer расширяется полноценным runtime media lifecycle комнаты.
**---**
**# 60. Room Media не содержит room business logic**
AudioService не решает:
\`\`\`text
кто host
кто может начать песню
room code
permissions
participant invitations
\`\`\`
Он получает готовую media session configuration.
**---**
**# 61. JoinMediaSession**
AudioService получает:
\`\`\`text
MediaSessionId
LocalParticipantId
RemoteParticipants
Codec Configuration
Transport Configuration
\`\`\`
**---**
**# 62. Local Voice Send**
Путь:
\`\`\`text
Selected Voice Tap
↓
NetworkQueue
↓
Encoder
↓
Packetizer
↓
Transport
\`\`\`
**---**
**# 63. Incoming Remote Voice**
\`\`\`text
Transport
↓
Packet Receiver
↓
Jitter Buffer
↓
Decoder
↓
RemoteVoiceSource
↓
Mixer
\`\`\`
**---**
**# 64. Remote participant source**
Для каждого participant существует отдельный:
\`\`\`text
RemoteVoiceSource
\`\`\`
с:
\`\`\`text
ParticipantId
Gain
Mute
Jitter State
Playback State
Level
\`\`\`
**---**
**# 65. SetRemoteGain**
Realtime command:
\`\`\`text
SetRemoteGain(participantId, gain)
\`\`\`
не требует restart media session.
**---**
**# 66. SetRemoteMute**
Local mute другого участника управляет только локальным Mixer Source.
Он не изменяет состояние удалённого пользователя.
**---**
**# 67. Remote speaking level**
AudioService публикует:
\`\`\`text
RemoteLevel
\`\`\`
из уже decoded PCM.
Не требуется отдельная обработка этого audio другим процессом.
**---**
**# 68. Network media diagnostics**
Для каждого remote participant:
\`\`\`text
Packet Loss
Jitter
JitterBufferFill
DecodeUnderruns
RemoteLevel
EstimatedPlayoutDelay
\`\`\`
**---**
**# 69. Local network diagnostics**
Для outgoing voice:
\`\`\`text
Encoder Queue Fill
Packets Sent
Dropped Audio Blocks
Encoder Latency
\`\`\`
**---**
**# 70. Media reconnect**
При временной потере transport:
\`\`\`text
Local Monitoring
Music Playback
Recording
\`\`\`
продолжают работать.
RemoteVoiceSources переходят в:
\`\`\`text
Disconnected / Buffering
\`\`\`
**---**
**# 71. Network recovery**
После reconnect старые buffered remote PCM не воспроизводятся как burst.
Создаётся новое playout mapping.
**---**
**# 72. Unified Media Source model**
Все runtime audio sources должны сводиться к одной понятной концепции:
\`\`\`text
MediaSource
\`\`\`
Но без создания чрезмерно универсального framework.
Типы source:
\`\`\`text
MusicSource
ReferenceVocalSource
MicrophoneSource
RemoteVoiceSource
RadioSource
PreviewSource
ReferenceToneSource
\`\`\`
**---**
**# 73. Каждый source имеет известные свойства**
По необходимости:
\`\`\`text
Gain
Mute
Channel Routing
Timeline
Buffer State
Latency Contribution
\`\`\`
**---**
**# 74. Source Priority / Exclusivity**
AudioService должен явно знать допустимые комбинации.
Например:
\`\`\`text
Karaoke Music + Mic + Remote Voices
\= allowed
Editor Preview + Mic
\= allowed if required
Radio + Karaoke Music
\= not allowed
Radio + Editor Preview
\= not allowed
\`\`\`
**---**
**# 75. Transport ownership**
Все runtime transport commands теперь принадлежат AudioService:
\`\`\`text
Play
Pause
Resume
Seek
Stop
Playback Rate
Transpose
\`\`\`
Для активной media context.
**---**
**# 76. Transport Context**
Чтобы команды не применялись к неправильному source, transport имеет explicit context.
Например:
\`\`\`text
Karaoke
EditorPreview
Radio
\`\`\`
**---**
**# 77. MediaContext**
В каждый момент AudioService знает активный foreground media context:
\`\`\`text
None
Karaoke
EditorPreview
Radio
\`\`\`
Room voice может работать параллельно с Karaoke.
**---**
**# 78. Foreground media transition**
Например:
\`\`\`text
Radio
↓
Open Karaoke
↓
Stop Radio
↓
Prepare Karaoke
↓
Karaoke Ready
\`\`\`
**---**
**# 79. Recording Playback Preview**
Для History/Recording UI AudioService может воспроизводить готовую запись как обычный local media source.
Команды:
\`\`\`text
LoadRecordingPreview
Play
Pause
Seek
Stop
\`\`\`
**---**
**# 80. Recording Preview не является новой audio subsystem**
Он использует существующий decoder + playback + Mixer + Render.
**---**
**# 81. Runtime Audio Settings**
Все live audio settings принадлежат AudioService.
Например:
\`\`\`text
Input Device
Output Device
Backend
Sample Rate
Period / Buffer
Input Channel
Output Channels
Microphone Gain
Monitoring Gain
Music Gain
Master Gain
DSP Parameters
\`\`\`
**---**
**# 82. Settings apply model**
Realtime-safe параметры:
\`\`\`text
Gain
Mute
DSP Parameter
\`\`\`
применяются без restart.
Structural parameters:
\`\`\`text
Device
Backend
Sample Rate
Period
Channels
\`\`\`
используют уже существующий Reconfiguration lifecycle.
**---**
**# 83. AudioService Settings Snapshot**
AudioService предоставляет единый snapshot:
\`\`\`text
RequestedConfiguration
RuntimeConfiguration
MixerState
DSPState
MonitoringState
PlaybackState
RecordingState
MediaSessionState
\`\`\`
**---**
**# 84. Live Diagnostics расширяются**
К уже существующей diagnostics добавить:
\`\`\`text
Playback State
Playback Position
Decoder State
Music Buffer Fill
Radio Buffer Fill
Preview Position
Recording State
Recording Queue Fill
Recording Duration
Local Input Peak / RMS
Remote Participant Levels
Network Jitter Buffers
\`\`\`
**---**
**# 85. Latency Breakdown расширяется**
Для Karaoke playback показывается:
\`\`\`text
Decoder Buffer
Music Resampling
Mixer
Render Padding
Output Driver
\`\`\`
Для local microphone monitoring сохраняется существующий breakdown.
Для remote voice:
\`\`\`text
Capture
Encoder
Packetization
Network
Jitter Buffer
Decoder
Remote Source Queue
Mixer
Render
\`\`\`
**---**
**# 86. Media failure model**
Добавить ошибки:
\`\`\`text
MediaFileNotFound
MediaDecodeFailed
UnsupportedMediaFormat
MusicUnderrun
PreviewFailed
RadioConnectionFailed
RecordingFileError
RecordingFinalizationFailed
RemoteMediaDisconnected
CodecError
\`\`\`
**---**
**# 87. Failure isolation**
Ошибка:
\`\`\`text
Radio
\`\`\`
не должна ломать:
\`\`\`text
AudioSession
\`\`\`
Ошибка:
\`\`\`text
Remote participant decoder
\`\`\`
не должна ломать остальных participants.
Ошибка:
\`\`\`text
Recording Writer
\`\`\`
не должна останавливать monitoring/playback.
**---**
**# 88. Playback failure**
Если основной MusicSource сломан:
\`\`\`text
PlaybackState = Failed
\`\`\`
но AudioService process и устройства могут оставаться активными.
**---**
**# 89. Media generation protection**
Playback load/seek/reload также должны учитывать существующий:
\`\`\`text
generationId
\`\`\`
Старый decoder callback не может наполнить buffer новой песни.
**---**
**# 90. Source generation**
Кроме session generation полезно различать активную media source generation.
Например:
\`\`\`text
Song A
↓
Seek
↓
Song A new source generation
или
Song A
↓
Load Song B
↓
new source generation
\`\`\`
Старые decoded frames отбрасываются.
**---**
**# 91. No stale PCM**
Правило распространяется теперь на:
\`\`\`text
Song playback
Recording preview
Editor preview
Radio
Remote voice
\`\`\`
После:
\`\`\`text
Stop
Seek
Reload
Reconnect
Source replacement
\`\`\`
старый PCM не может появиться на output.
**---**
**# 92. Media resource preloading**
AudioService должен позволять подготовить source до Play.
Например:
\`\`\`text
LoadSong
↓
Decode Initial Data
↓
Ready
↓
Play
\`\`\`
Это уменьшает:
\`\`\`text
Play command → first audible frame
\`\`\`
**---**
**# 93. First Audio latency**
Для каждого media type можно измерять:
\`\`\`text
Load-to-Ready
Play-to-FirstFrame
\`\`\`
**---**
**# 94. Playback не должен влиять на Monitoring latency**
Критический инвариант:
\`\`\`text
Monitoring latency
\`\`\`
не должна существенно увеличиваться из-за:
\`\`\`text
Music playback
Recording
Radio decoder
Network audio
Diagnostics
\`\`\`
**---**
**# 95. Recording не должна влиять на Monitoring latency**
Disk slowdown и recording queue работают независимо.
**---**
**# 96. Remote Media не должна влиять на local Monitoring latency**
Плохая сеть другого пользователя не увеличивает local microphone monitoring latency.
**---**
**# 97. Decoder overload не должен блокировать realtime**
Для каждого decoder используется bounded asynchronous preparation.
**---**
**# 98. Unified command surface**
К существующему IPC AudioService добавить команды по областям.
**## Playback**
\`\`\`text
LoadSong
UnloadSong
Play
Pause
Resume
Stop
Seek
SetPlaybackRate
SetTranspose
SetMusicGain
SetReferenceVocalGain
\`\`\`
**## Recording**
\`\`\`text
PrepareRecording
StartRecording
PauseRecording
ResumeRecording
StopRecording
GetRecordingState
\`\`\`
**## Signal**
\`\`\`text
GetInputLevel
StartInputTest
StopInputTest
PlayOutputTest
\`\`\`
**## Preview**
\`\`\`text
LoadPreview
PlayPreview
PausePreview
StopPreview
SeekPreview
SetPreviewLoop
PlayReferenceTone
\`\`\`
**## Radio**
\`\`\`text
LoadRadioStation
PlayRadio
PauseRadio
StopRadio
SetRadioGain
\`\`\`
**## Remote Media**
\`\`\`text
JoinMediaSession
LeaveMediaSession
AddRemoteParticipant
RemoveRemoteParticipant
SetRemoteGain
SetRemoteMute
\`\`\`
**---**
**# 99. AudioService events**
Добавить события:
\`\`\`text
PlaybackReady
PlaybackStarted
PlaybackPaused
PlaybackPosition
PlaybackFinished
PlaybackFailed
RecordingStarted
RecordingPaused
RecordingFinalizing
RecordingFinished
RecordingFailed
InputSignalChanged
InputClipping
MusicUnderrun
RemoteParticipantMediaReady
RemoteParticipantMediaLost
RadioBuffering
RadioFailed
PreviewPosition
\`\`\`
**---**
**# 100. IPC не переносит PCM**
Даже после расширения:
\`\`\`text
IPC
\`\`\`
используется только для:
\`\`\`text
commands
state
events
diagnostics
paths
metadata
\`\`\`
PCM остаётся внутри AudioService.
**---**
**# 101. Что AudioService всё ещё НЕ делает**
Несмотря на расширение, AudioService не превращается в application backend.
Он не отвечает за:
\`\`\`text
Song Library
Database
Song Metadata Persistence
Lyrics Search
Lyrics Persistence
Melody Editor Document Save
AI Song Processing
Stem Separation
ASR
Forced Alignment
Offline Performance Scoring
Song Package Import / Export
Room Business Logic
User Accounts
Application History Database
\`\`\`
**---**
**# 102. Граница AudioService после дополнения**
AudioService владеет:
\`\`\`text
ВСЕМ, ЧТО ЗВУЧИТ ИЛИ ДОЛЖНО ЗВУЧАТЬ СЕЙЧАС
\`\`\`
а также:
\`\`\`text
ВСЕМ, ЧТО ЗАПИСЫВАЕТ LIVE AUDIO СЕЙЧАС
\`\`\`
и:
\`\`\`text
ВСЕМ, ЧТО НУЖНО ДЛЯ СИНХРОНИЗАЦИИ ЭТОГО LIVE AUDIO
\`\`\`
**---**
**# 103. Новая полная runtime media схема**
\`\`\`text
                    AUDIO SERVICE
                         │
             ┌───────────┴───────────┐
             │                       │
         Local Media             Live Input
             │                       │
     ┌───────┼───────┐               │
     │       │       │               │
   Song    Radio   Preview           Mic
     │       │       │               │
     └───────┴───────┴───────┬───────┘
                             │
                         SignalGraph
                             │
                ┌────────────┼────────────┐
                │            │            │
              DSP        Recording      Network Send
                │
                │                         │
                │                    Remote Network
                │                         │
                │                    Jitter/Decode
                │                         │
                └────────────┬────────────┘
                             │
                           Mixer
                             │
                     Master Processing
                             │
                           Render
                             │
                         OUTPUT
\`\`\`
**---**
**# 104. Главный runtime принцип после дополнения**
\`\`\`text
Если функция управляет живым звуком,
его временем,
его маршрутизацией,
его записью
или его передачей в реальном времени
        ↓
она принадлежит AudioService
\`\`\`
**---**
**# 105. Главный принцип против разрастания AudioService**
При этом нельзя переносить в него функцию только потому, что она связана со звуком.
Если функция:
\`\`\`text
offline
\`\`\`
и не влияет на работающую audio session:
\`\`\`text
она не является обязанностью AudioService
\`\`\`
Таким образом сервис остаётся:
\`\`\`text
Realtime Media Engine
\`\`\`
а не превращается в универсальный backend приложения.