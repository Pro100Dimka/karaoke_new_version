**# Финальный подробный план реализации AudioService**
Этот документ описывает **\*\*основную фазу\*\*** AudioService. После выполнения её
требований и пользовательской проверки этапов 0–18 запланирована
[фаза II: runtime media]\(AudioService-runtime-media-extension.md) с
[отдельными проверяемыми этапами]\(AudioService-runtime-media-stages.md).
Фаза II расширяет существующие recording, analysis, network, mixer и playback
границы; она не объявляет их уже реализованными и не заменяет правила этой фазы.
**## 0. Главный принцип разработки**
AudioService нельзя писать как один огромный проект, который сначала «полностью реализуется», а потом тестируется.
Правильная стратегия:
\`\`\`text
MINIMAL WORKING VERTICAL SLICE
↓
TEST
↓
DIAGNOSE
↓
MEASURE LATENCY
↓
MEASURE CPU
↓
CHECK MEMORY / THREADING / OWNERSHIP
↓
COMPARE WITH BASELINE
↓
ONLY THEN ADD NEXT FEATURE
\`\`\`
Главная первая реальная цель:
\`\`\`text
MIC
↓
CAPTURE
↓
MINIMAL REQUIRED CONVERSION
↓
CLOCK SYNCHRONIZATION
↓
MIXER
↓
RENDER
↓
HEADPHONES
\`\`\`
Без:
\`\`\`text
Recording
Analysis
Network
Remote Voices
Pitch
Noise Reduction
Reverb
Delay
сложного DSP
\`\`\`
Пока этот путь не работает стабильно, предсказуемо и с минимальной задержкой, дальше идти нельзя.
**### Универсальность поддерживаемого оборудования**
AudioService проектируется для максимально широкого набора **\*\*поддерживаемых\*\*** Windows x64 систем и устройств, а не под машину разработчика. Имя, ID/GUID, производитель, драйвер, sample rate, period/buffer size, формат и число каналов не являются константами реального аудиопути. Значения FakeBackend — только воспроизводимые тестовые данные. Фраза «работает на моём компьютере» не является доказательством корректности.
Перед открытием backend определяет доступные устройства и их возможности через API, а после открытия читает фактические параметры заново. Запрошенные и фактические значения хранятся раздельно. Если возможность зависит от устройства или драйвера, сначала проверяется её поддержка; выбор выполняется по цепочке \`requested → ближайший/лучший поддерживаемый → безопасный fallback\`. Отсутствие подходящего варианта, выбранного ранее устройства или возможности приводит к диагностируемому отказу без падения и зависания. Оптимизация основывается на capabilities, не на названии устройства; исключение по модели допустимо только для документированного бага.
Контракт backend и подготовка графа должны принимать переменное число частот/форматов и runtime channels/periods, включая mono, stereo и multichannel там, где это поддерживают backend и выбранный путь. Отдельно проверяются встроенные устройства, USB, профессиональные интерфейсы и Bluetooth, если он поддерживается backend, а также смена и отключение устройства. Тесты используют несколько несовпадающих fake-конфигураций; реальные устройства проверяются на соответствующих аппаратных этапах. Специализированное решение для одной модели не выбирается, если пользователь явно этого не потребовал.
**---**
**# 1. Создать отдельный AudioService.exe**
Первым создаётся отдельный процесс:
\`\`\`text
AudioService.exe
\`\`\`
Он должен быть независим от frontend.
Он владеет:
\`\`\`text
Audio backends
Input streams
Output streams
Realtime threads
Signal graph
Clocks
Buffers
DSP
Recording path
Network audio path
Diagnostics
\`\`\`
Frontend не владеет realtime audio.
**---**
**# 2. Начальное состояние сервиса**
После запуска:
\`\`\`text
ServiceState:
Running
SessionState:
Idle
Input:
Closed
Output:
Closed
Monitoring:
Off
Recording:
Off
Transmission:
Off
\`\`\`
Никакое пользовательское устройство ещё не открывается.
**---**
**# 3. Service lifecycle**
Зафиксировать состояния самого процесса:
\`\`\`text
Starting
↓
Running
↓
Stopping
↓
Stopped
\`\`\`
Дополнительно:
\`\`\`text
Failed
\`\`\`
Сервис не должен зависеть от lifecycle Electron/React.
**---**
**# 4. IPC foundation**
Сразу создать control IPC.
Минимальные команды:
\`\`\`text
GetServiceState
GetDevices
GetDiagnostics
PrepareSession
StartSession
StopSession
SetMonitoring
SetGain
Reconfigure
ShutdownService
\`\`\`
Через IPC передаются только:
\`\`\`text
Commands
Configuration
Parameters
State
Diagnostics
Events
\`\`\`
**---**
**# 5. PCM через frontend запрещён**
Нельзя строить:
\`\`\`text
MIC
↓
AudioService
↓
IPC
↓
Electron
↓
WebAudio
↓
Output
\`\`\`
Правильно:
\`\`\`text
MIC
↓
AudioService
↓
OUTPUT
\`\`\`
Frontend только управляет AudioService.
**---**
**# 6. IPC versioning**
С первой версии добавить:
\`\`\`text
ProtocolVersion
\`\`\`
Frontend и AudioService должны уметь определить:
\`\`\`text
Compatible
\`\`\`
или:
\`\`\`text
ProtocolVersionMismatch
\`\`\`
Нельзя позволять старому frontend случайно управлять несовместимой новой версией сервиса.
**---**
**# 7. Session State Machine**
Создать строгую state machine:
\`\`\`text
Idle
↓
Opening
↓
Prepared
↓
Starting
↓
Running
↓
Stopping
↓
Idle
\`\`\`
Дополнительные состояния:
\`\`\`text
Recovering
Suspended
Failed
\`\`\`
Все переходы выполняет:
\`\`\`text
SessionManager
\`\`\`
**---**
**# 8. Один источник истины**
Не должно существовать:
\`\`\`text
Frontend думает Running
Backend думает Starting
SessionManager думает Stopping
\`\`\`
Authoritative state хранится только в AudioService.
Frontend получает snapshot этого состояния.
**---**
**# 9. generationId**
Каждая новая активная generation получает:
\`\`\`text
generationId
\`\`\`
Например:
\`\`\`text
41
\`\`\`
После:
\`\`\`text
Recovery
Reconfiguration
Resume
Backend restart
\`\`\`
создаётся:
\`\`\`text
42
\`\`\`
**---**
**# 10. Старые callbacks**
Любой async callback должен знать:
\`\`\`text
generationId
\`\`\`
Если приходит:
\`\`\`text
callback.generationId = 41
\`\`\`
а активная generation:
\`\`\`text
42
\`\`\`
callback ничего не делает.
**---**
**# 11. generationId применяется везде**
Минимум:
\`\`\`text
Backend callbacks
Device notifications
Recording callbacks
Analysis callbacks
Network callbacks
Recovery
Reconfiguration
Diagnostics async work
\`\`\`
**---**
**# 12. Ownership model**
До написания real audio path зафиксировать ownership.
Например:
\`\`\`text
AudioService
owns
SessionManager
SessionManager
owns
AudioSession
AudioSession
owns
Backend
SignalGraph
ClockSynchronizer
RealtimeBufferPool
Consumers
\`\`\`
**---**
**# 13. Ownership должен быть однозначным**
Для любого объекта должен существовать ответ:
\`\`\`text
Кто создаёт?
Кто владеет?
Кто останавливает?
Кто уничтожает?
На каком thread?
\`\`\`
**---**
**# 14. Threading model**
Сразу зафиксировать список threads.
Например:
\`\`\`text
Control / Session Thread
Realtime Audio Thread
Recording Worker
Analysis Worker
Network Send Worker
Network Receive Worker
Diagnostics Aggregator
Device Notification Thread
IPC Thread
\`\`\`
**---**
**# 15. Thread communication**
Для каждой пары определить:
\`\`\`text
Atomic state
Bounded queue
Snapshot
Event
или communication запрещён
\`\`\`
Не использовать случайные mutex между всем подряд.
**---**
**# 16. Realtime Contract**
Realtime thread не выполняет:
\`\`\`text
Disk I/O
Network I/O
Blocking IPC
Sleep
Blocking Mutex Wait
Device Enumeration
Device Open
Device Close
File Logging
Thread Creation
Heap Allocation в steady-state
Heap Free в steady-state
Unbounded Queue Operations
Waiting For Consumer
\`\`\`
**---**
**# 17. Realtime разрешено**
\`\`\`text
Preallocated Memory
Bounded Queues
Atomics
Prepared Buffers
Prepared DSP
Prepared Resamplers
Non-blocking Events
\`\`\`
**---**
**# 18. Exceptions через realtime boundary запрещены**
Ошибка внутри realtime обработки не должна вылетать наружу exception'ом.
Она превращается в:
\`\`\`text
Error flag
Diagnostic event
Controlled bypass
Session failure
\`\`\`
согласно policy.
**---**
**# 19. Error model**
Сразу определить группы ошибок.
Например:
\`\`\`text
ConfigurationError
BackendError
DeviceLost
DeviceInvalidated
RealtimeOverrun
RecordingError
NetworkError
DSPError
IPCError
\`\`\`
**---**
**# 20. Severity model**
Каждую ошибку классифицировать:
\`\`\`text
Recoverable
SessionFatal
ServiceFatal
\`\`\`
**---**
**# 21. Diagnostics foundation**
Diagnostics создаётся до real WASAPI.
Минимальные компоненты:
\`\`\`text
AudioDiagnostics
TraceBuffer
LatencyRegistry
GraphDump
SessionSnapshot
\`\`\`
**---**
**# 22. TraceBuffer**
Создать bounded ring buffer последних событий.
Например:
\`\`\`text
SessionOpening
BackendOpened
BackendStarted
CaptureDiscontinuity
RenderUnderrun
DeadlineMiss
DeviceLost
RecoveryStarted
RecoveryCompleted
\`\`\`
**---**
**# 23. TraceBuffer realtime-safe**
Realtime thread только пишет компактную структуру:
\`\`\`text
timestamp
sessionFrame
generationId
eventType
small payload
\`\`\`
Никакой записи файла внутри RT.
**---**
**# 24. SessionSnapshot**
Создать единый консистентный snapshot для frontend/diagnostics.
Например:
\`\`\`text
SessionState
generationId
Backend
RequestedConfiguration
RuntimeConfiguration
ClockState
QueueState
LatencyState
ErrorState
\`\`\`
Frontend не должен собирать состояние из десятков отдельных atomics.
**---**
**# 25. audio-dump**
Сразу создать команду:
\`\`\`text
audio-dump
\`\`\`
На первых этапах она показывает:
\`\`\`text
Service State
Session State
generationId
Backend
Requested Configuration
Runtime Configuration
Errors
\`\`\`
Позже автоматически расширяется.
**---**
**# 26. IAudioBackend**
Создать минимальную backend abstraction.
Концептуально:
\`\`\`text
queryCapabilities()
open()
runtimeConfiguration()
start()
stop()
close()
\`\`\`
**---**
**# 27. Не делать IAudioBackend огромным**
Не нужно заставлять ASIO и WASAPI выглядеть одинаково внутри.
Общий interface должен описывать:
\`\`\`text
что нужно AudioSession
\`\`\`
а не все возможные детали драйвера.
**---**
**# 28. FakeAudioBackend**
Следующий обязательный этап — FakeAudioBackend.
До настоящего WASAPI.
**---**
**# 29. Fake backend parameters**
Он должен позволять задавать:
\`\`\`text
Input Sample Rate
Output Sample Rate
Input Period
Output Period
Endpoint Buffer
Input Channels
Output Channels
Capture Packet Sizes
\`\`\`
**---**
**# 30. Fake backend должен уметь возвращать Runtime != Requested**
Например:
\`\`\`text
Requested:
128 frames
Capabilities:
128 frames
Runtime:
144 frames
\`\`\`
Engine обязан использовать:
\`\`\`text
144
\`\`\`
**---**
**# 31. Fake backend clocks**
Добавить:
\`\`\`text
CaptureClock
RenderClock
\`\`\`
С возможностью задавать drift:
\`\`\`text
0 ppm
+10 ppm
-10 ppm
+50 ppm
-50 ppm
+500 ppm
\`\`\`
**---**
**# 32. Fake backend jitter**
Имитировать timestamp jitter без реального frequency drift.
Estimator не должен принимать jitter за drift.
**---**
**# 33. Fake backend fault injection**
Уметь вызвать в заданный момент:
\`\`\`text
DeviceLost
DeviceInvalidated
TimestampError
DataDiscontinuity
ClockJump
CaptureOverrun
RenderUnderrun
DriverReset
BackendHang
\`\`\`
**---**
**# 34. Configuration models**
Зафиксировать отдельные структуры:
\`\`\`text
RequestedConfiguration
AudioDeviceCapabilities
RuntimeConfiguration
FinalSessionPlan
\`\`\`
Никогда не объединять их.
**---**
**# 35. RequestedConfiguration**
Содержит только то, что хочет приложение:
\`\`\`text
Input Device
Output Device
Backend
Requested Sample Rate
Requested Period / Buffer
Input Channels
Output Channels
\`\`\`
**---**
**# 36. AudioDeviceCapabilities**
Содержит то, что backend сообщил до открытия.
Например:
\`\`\`text
Supported Sample Rates
Supported Formats
Min Period
Max Period
Default Period
ASIO Buffer Limits
Channels
\`\`\`
**---**
**# 37. RuntimeConfiguration**
Содержит фактическое состояние открытого backend.
Например:
\`\`\`text
Runtime Input Sample Rate
Runtime Output Sample Rate
Runtime Input Period
Runtime Output Period
Runtime Input Endpoint Buffer
Runtime Output Endpoint Buffer
Runtime Channels
Runtime Format
Runtime Latencies
\`\`\`
**---**
**# 38. FinalSessionPlan**
Создаётся только после RuntimeConfiguration.
Содержит:
\`\`\`text
Internal Sample Rate
Internal Format
Required Conversions
Required Resamplers
Maximum Block Size
Clock Relationship
Memory Requirements
Signal Graph Requirements
\`\`\`
**---**
**# 39. Units policy**
Нельзя использовать непонятные:
\`\`\`text
size
duration
latencyValue
\`\`\`
Использовать:
\`\`\`text
frames
samples
sampleRateHz
milliseconds
qpcTicks
bytes
\`\`\`
**---**
**# 40. Timeline внутри engine**
Основная audio timeline хранится в:
\`\`\`text
frames
\`\`\`
и integer timestamps.
Milliseconds используются в основном для:
\`\`\`text
UI
Diagnostics
Reports
\`\`\`
**---**
**# 41. DeviceManager**
Теперь создать настоящий DeviceManager.
**---**
**# 42. Device discovery**
Получать:
\`\`\`text
WASAPI Input Endpoints
WASAPI Output Endpoints
ASIO Drivers
ASIO Channels
\`\`\`
**---**
**# 43. Device identity**
Основной ключ:
\`\`\`text
Stable Device ID
\`\`\`
Friendly name только для UI.
**---**
**# 44. Device metadata**
Хранить:
\`\`\`text
Device ID
Name
State
Backend
Direction
Channels
Driver Version
Default Device Status
\`\`\`
**---**
**# 45. Device notifications**
Поддержать:
\`\`\`text
Added
Removed
Enabled
Disabled
DefaultChanged
PropertyChanged
\`\`\`
**---**
**# 46. Notification не меняет устройство автоматически**
Если выбрано конкретное:
\`\`\`text
Device ID X
\`\`\`
смена Windows default device сама по себе не должна переключить session.
**---**
**# 47. RealtimeBufferPool**
Теперь создать общий preallocated memory pool.
**---**
**# 48. Максимумы определить заранее**
Например:
\`\`\`text
MaxChannels
MaxBlockFrames
MaxRemoteUsers
MaxConsumerQueues
MaxDiagnosticEvents
\`\`\`
Это помогает гарантировать bounded memory.
**---**
**# 49. Memory layout**
Выбрать один внутренний PCM layout:
\`\`\`text
Planar
\`\`\`
или:
\`\`\`text
Interleaved
\`\`\`
И использовать его последовательно внутри core.
Не менять representation хаотично между DSP.
**---**
**# 50. AudioBlock**
Минимальная структура:
\`\`\`text
sequence
generationId
sessionFrame
frameCount
sampleRate
channelCount
devicePosition
timestamp
flags
PCM pointer / view
\`\`\`
**---**
**# 51. Bare SignalGraph**
Теперь создать первый audio graph.
\`\`\`text
Capture
↓
Input Boundary Conversion
↓
RawInput
↓
Microphone Gate
↓
Input Gain
↓
Mixer
↓
Output Boundary Conversion
↓
Render
\`\`\`
**---**
**# 52. Пока никакого DSP**
На этом этапе:
\`\`\`text
DSP count = 0
\`\`\`
**---**
**# 53. Input Boundary Conversion**
Только обязательные технические операции:
\`\`\`text
Integer PCM → float32
Interleaved → Internal Layout
Channel Mapping
Required Sample Rate Conversion
\`\`\`
**---**
**# 54. RawInput**
После boundary conversion:
\`\`\`text
RawInput
\`\`\`
Это первый стабильный internal representation сигнала.
**---**
**# 55. CaptureEnabled**
Управляет физическим capture stream.
**---**
**# 56. MicrophoneEnabled**
Управляет прохождением captured microphone через application graph.
Можно:
\`\`\`text
CaptureEnabled = true
MicrophoneEnabled = false
\`\`\`
**---**
**# 57. Mixer v1**
Первая версия Mixer:
\`\`\`text
Mic
↓
Gain
↓
Stereo Output
\`\`\`
**---**
**# 58. Mixer correctness tests**
Проверить:
\`\`\`text
Gain = 1
→ unchanged signal
Gain = 0
→ silence
Mute
→ silence
\`\`\`
**---**
**# 59. Clock architecture**
Создать:
\`\`\`text
CaptureClock
RenderClock
ClockSynchronizer
\`\`\`
**---**
**# 60. Что внутри ClockSynchronizer**
\`\`\`text
Clock Mapping
Drift Estimation
ClockBridge
Adaptive Resampler
Outlier Filtering
Controlled Resync
\`\`\`
**---**
**# 61. SessionFrame**
Создать absolute session timeline.
Например:
\`\`\`text
Block A:
sessionFrame = 100000
frameCount = 144
Block B:
sessionFrame = 100144
frameCount = 96
\`\`\`
**---**
**# 62. Render timeline — presentation reference**
Для karaoke output timeline определяет:
\`\`\`text
что должно реально звучать сейчас
\`\`\`
**---**
**# 63. Clock domains**
Backend определяет:
\`\`\`text
Same Clock Domain
\`\`\`
или:
\`\`\`text
Independent Clock Domains
\`\`\`
**---**
**# 64. Independent clocks**
Например:
\`\`\`text
USB Microphone
\+
Realtek Output
\`\`\`
требуют synchronization.
**---**
**# 65. ClockBridge**
Путь:
\`\`\`text
Capture
↓
Small Bounded ClockBridge
↓
Adaptive Resampler
↓
Render Timeline
\`\`\`
**---**
**# 66. ClockBridge TargetFill**
Не стремиться к нулю.
Использовать:
\`\`\`text
TargetFill
\`\`\`
например около одного processing period, если этого хватает для стабильности.
**---**
**# 67. Drift estimation**
Использовать:
\`\`\`text
Capture DevicePosition + Timestamp
\`\`\`
против:
\`\`\`text
Render DevicePosition + Timestamp
\`\`\`
**---**
**# 68. Queue fill — дополнительный feedback**
ClockBridge fill помогает контроллеру, но не является единственным источником drift estimate.
**---**
**# 69. Clock filtering**
Защищаться от:
\`\`\`text
Timestamp Jitter
Invalid Timestamp
Single Outlier
Discontinuity
\`\`\`
**---**
**# 70. Drift correction**
Ratio изменять плавно:
\`\`\`text
1.000000
1.000004
1.000008
\`\`\`
**---**
**# 71. Drift correction limits**
Определить:
\`\`\`text
MaxCorrectionPpm
MaxRatioSlew
\`\`\`
**---**
**# 72. Controlled resync**
Если normal adaptive correction уже недостаточно:
\`\`\`text
Controlled Resync
\`\`\`
**---**
**# 73. Fake clock tests**
До real WASAPI проверить:
\`\`\`text
0 ppm
±10 ppm
±50 ppm
±100 ppm
±500 ppm
Jitter
Outliers
Missing observations
Clock jump
Sign change
\`\`\`
**---**
**# 74. Fault Injection Foundation**
К этому моменту уже должны существовать автоматические tests для:
\`\`\`text
DeviceLost
TimestampError
ClockJump
Underrun
Overrun
Old callback
\`\`\`
**---**
**# 75. Первый настоящий backend — WASAPI Shared**
Теперь подключается реальное Windows audio.
Это главный первый production backend.
**---**
**# 76. Почему Shared первый**
Потому что это основной режим для обычных пользователей без профессионального interface.
Именно его нужно первым довести до:
\`\`\`text
minimum stable practical latency
\`\`\`
**---**
**# 77. WASAPI Shared capabilities**
Читать:
\`\`\`text
Mix Format
Current Engine Format
Observed Engine Period
Minimum Period
Maximum Period
Default Period
Fundamental Period
Channel Layout
\`\`\`
**---**
**# 78. Observed != Runtime**
Observed period до открытия не использовать как final truth.
**---**
**# 79. Requested Shared period validation**
Например:
\`\`\`text
Requested = 128
\`\`\`
Проверить:
\`\`\`text
\>= minimum
<= maximum
compatible with fundamental period
\`\`\`
**---**
**# 80. WASAPI open**
Последовательность:
\`\`\`text
Open Capture Endpoint
↓
Open Render Endpoint
↓
Initialize Clients
↓
Read Runtime Parameters
\`\`\`
Пока не Start.
**---**
**# 81. Runtime reread**
После открытия обязательно получить:
\`\`\`text
Runtime Sample Rate
Runtime Processing Period
Runtime Endpoint Buffer
Runtime Format
Runtime Channels
Runtime Latency Information
\`\`\`
**---**
**# 82. FinalSessionPlan строится после Runtime**
Теперь вычислить:
\`\`\`text
MaximumBlockSize
Required Conversions
Clock Relationship
Memory Requirements
Graph Layout
\`\`\`
**---**
**# 83. Allocate RT resources только теперь**
Под реальные runtime values подготовить:
\`\`\`text
Capture Buffers
Render Buffers
ClockBridge
Mixer Buffers
Conversion Buffers
\`\`\`
**---**
**# 84. Event-driven WASAPI**
Realtime должен быть event-driven.
Не:
\`\`\`text
Sleep()
Polling timer
Busy loop
\`\`\`
**---**
**# 85. MMCSS**
Realtime thread зарегистрировать в подходящем MMCSS task class.
**---**
**# 86. MMCSS diagnostics**
Если registration не удался:
\`\`\`text
Diagnostics:
MMCSS = Failed
\`\`\`
Нельзя молча считать режим low-latency.
**---**
**# 87. WASAPI Capture loop**
\`\`\`text
Capture Event
↓
while packet available
↓
GetBuffer
↓
Read frameCount
↓
Read flags
↓
Read devicePosition
↓
Read timestamp
↓
Validate
↓
Process
↓
ReleaseBuffer
\`\`\`
**---**
**# 88. Drain all available packets**
Нельзя предполагать:
\`\`\`text
1 wake = 1 packet
\`\`\`
**---**
**# 89. Variable packet sizes**
Поддерживать:
\`\`\`text
144
144
96
144
72
\`\`\`
**---**
**# 90. SILENT**
При silent flag:
\`\`\`text
Input = zero samples
\`\`\`
**---**
**# 91. DATA\_DISCONTINUITY**
Фиксировать:
\`\`\`text
Diagnostic Event
Gap if necessary
Clock validation
\`\`\`
**---**
**# 92. Invalid Timestamp**
Не использовать invalid timestamp в drift estimator.
**---**
**# 93. WASAPI Render loop**
\`\`\`text
Render Event
↓
Read EndpointBufferFrames
↓
Read CurrentPaddingFrames
↓
FramesAvailable =
Buffer - Padding
↓
Generate required interval
↓
Submit
\`\`\`
**---**
**# 94. CurrentPadding входит в latency**
Queued render PCM — это реальная задержка.
**---**
**# 95. Minimum Prefill**
На старте добавляется только реально необходимый prefill.
Никаких скрытых:
\`\`\`text
extra 20 ms just in case
\`\`\`
**---**
**# 96. Первый реальный milestone**
Теперь должно работать:
\`\`\`text
MIC
↓
WASAPI Shared Capture
↓
Minimal Conversion
↓
Clock Synchronization
↓
Mixer
↓
WASAPI Shared Render
↓
HEADPHONES
\`\`\`
**---**
**# 97. На этом этапе остановиться**
Не добавлять ещё функциональность.
Сначала доказать bare monitoring.
**---**
**# 98. Software latency measurement**
Impulse внутри engine.
Измерить:
\`\`\`text
Input SessionFrame
→
Output SessionFrame
\`\`\`
**---**
**# 99. Physical loopback**
\`\`\`text
Physical Output
↓
Cable
↓
Physical Input
\`\`\`
Измерить реальный round trip.
**---**
**# 100. Baseline A**
Абсолютный minimum engine baseline:
\`\`\`text
Capture
→
Mixer
→
Render
\`\`\`
Без:
\`\`\`text
DSP
Recording
Analysis
Network
\`\`\`
**---**
**# 101. Сохранить Baseline A**
Хранить:
\`\`\`text
Device
Driver Version
Sample Rate
Runtime Period
Endpoint Buffer
Software Latency
Physical Latency
CPU Average
CPU Peak
XRuns
Deadline Misses
\`\`\`
**---**
**# 102. WASAPI Shared tuning**
Проверить:
\`\`\`text
Minimum Period
Next Valid Period
Default Period
Large Period
\`\`\`
**---**
**# 103. Выбирать minimum stable period**
Не:
\`\`\`text
самое маленькое значение любой ценой
\`\`\`
а:
\`\`\`text
минимальное значение без постоянных xruns/deadline misses
\`\`\`
**---**
**# 104. Device Loss рано**
Уже сейчас проверить:
\`\`\`text
Unplug Input
Unplug Output
Disable Device
Restart Windows Audio Service
\`\`\`
**---**
**# 105. Recovery**
Recovery:
\`\`\`text
Invalidate Old Generation
↓
Stop / Destroy Old Backend
↓
Open Same Device
↓
Read Runtime Again
↓
Prepare Resources
↓
Create New Clocks
↓
Create New generationId
↓
Start
\`\`\`
**---**
**# 106. Старые clocks запрещены**
После recovery:
\`\`\`text
Old CaptureClock
Old RenderClock
Old Drift State
\`\`\`
не используются.
**---**
**# 107. Old PCM protection**
Очистить/инвалидировать:
\`\`\`text
Render Queue
ClockBridge
Source Buffers
Old AudioBlocks
\`\`\`
**---**
**# 108. Reconfiguration тоже сделать рано**
Bare monitoring path должен уже уметь менять:
\`\`\`text
Input Device
Output Device
Sample Rate
Period
\`\`\`
**---**
**# 109. Reconfiguration sequence**
Лучше:
\`\`\`text
Receive New Request
↓
Validate
↓
Prepare New Backend
↓
Read New Runtime
↓
Prepare New Resources
↓
Commit
↓
Invalidate Old Generation
↓
Start New Generation
\`\`\`
**---**
**# 110. Sleep / Resume**
Реализовать ещё до Recording/Network.
**---**
**# 111. Resume**
\`\`\`text
Rediscover
↓
Reopen
↓
Read Runtime
↓
Prepare
↓
Recreate Clocks
↓
New generationId
↓
Start
\`\`\`
**---**
**# 112. Long Drift Test**
Bare monitoring:
\`\`\`text
1 hour
8 hours
\`\`\`
Особенно:
\`\`\`text
USB Mic
\+
Separate Output
\`\`\`
**---**
**# 113. Queue creep test**
Через несколько часов:
\`\`\`text
ClockBridge Fill
\`\`\`
не должен постоянно расти или падать.
**---**
**# 114. Shared soak**
Перед следующим backend:
\`\`\`text
Shared monitoring
8 hours
\`\`\`
**---**
**# 115. WASAPI Exclusive**
Теперь добавить Exclusive.
До Recording/Network.
**---**
**# 116. Почему Exclusive сейчас**
Чтобы доказать, что общий audio core действительно backend-agnostic до расширения продукта.
**---**
**# 117. Exclusive tests**
Проверить:
\`\`\`text
Supported Format
Unsupported Format
Device Busy
Exclusive Disabled
Other Exclusive Client
Device Invalidated
\`\`\`
**---**
**# 118. Exclusive latency baseline**
Создать отдельный baseline.
Сравнить:
\`\`\`text
Shared
Exclusive
\`\`\`
по:
\`\`\`text
Actual latency
CPU
Stability
\`\`\`
Не предполагать заранее, что Exclusive быстрее.
**---**
**# 119. ASIO**
После Shared и Exclusive.
**---**
**# 120. ASIO lifecycle**
\`\`\`text
Load Driver
↓
Read Capabilities
↓
Select Input/Output Channels
↓
Set Sample Rate
↓
Create Buffers
↓
Register Callbacks
↓
Read Latencies
↓
Start Driver
\`\`\`
**---**
**# 121. ASIO — единая driver session**
Не моделировать искусственно как два полностью независимых endpoint streams.
**---**
**# 122. ASIO callback support**
Поддержать:
\`\`\`text
Buffer Switch
Sample Position
Reset Request
Sample Rate Change
Driver Messages
\`\`\`
**---**
**# 123. ASIO hostile-driver tests**
Проверить:
\`\`\`text
Callback During Stop
Reset During Processing
Unexpected Message
Callback After Close
Driver Hang
\`\`\`
**---**
**# 124. ASIO latency baseline**
Измерить:
\`\`\`text
Software Latency
Physical Round Trip
CPU
XRuns
\`\`\`
**---**
**# 125. Cross-backend certification**
Теперь один и тот же bare SignalGraph должен пройти:
\`\`\`text
Fake
WASAPI Shared
WASAPI Exclusive
ASIO
\`\`\`
**---**
**# 126. Backend contract должен совпадать**
Проверить одинаковые semantics:
\`\`\`text
Session State
RuntimeConfiguration
Generation
Diagnostics
Failure Reporting
\`\`\`
**---**
**# 127. Local audio core считается доказанным**
Только после этого переходить к consumers.
**---**
**# 128. Recording**
Создать:
\`\`\`text
RecordingQueue
RecordingWorker
RecordingWriter
\`\`\`
**---**
**# 129. Recording realtime path**
\`\`\`text
AudioBlock
↓
RecordingQueue
\`\`\`
На этом realtime заканчивается.
**---**
**# 130. Recording taps**
Поначалу:
\`\`\`text
RawInput
MasterMix
\`\`\`
Позже:
\`\`\`text
CleanVoice
ProcessedVoice
\`\`\`
**---**
**# 131. Recording start/stop metadata**
Хранить:
\`\`\`text
recordingStartSessionFrame
recordingStopSessionFrame
Timestamp
\`\`\`
**---**
**# 132. Recording duration correctness**
Обязательный test:
\`\`\`text
30 seconds
→
approximately sampleRate × 30 frames
\`\`\`
**---**
**# 133. Slow Disk Test**
Writer искусственно тормозит.
Local monitoring:
\`\`\`text
latency unchanged
\`\`\`
**---**
**# 134. Recording Overflow**
При переполнении:
\`\`\`text
RecordingOverrun
GapMetadata
\`\`\`
Не silent drop.
**---**
**# 135. Disk failures**
Проверить:
\`\`\`text
Disk Full
Permission Error
Writer Error
\`\`\`
Realtime остаётся жив.
**---**
**# 136. Analysis**
Создать:
\`\`\`text
AnalysisQueue
AnalysisWorker
\`\`\`
**---**
**# 137. Analysis overload**
Analysis 10x slower than realtime.
Monitoring latency не должна измениться.
**---**
**# 138. Network Send**
\`\`\`text
VoiceTap
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
**# 139. Codec не на RT thread**
Encoder работает отдельно.
**---**
**# 140. Network Receive**
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
\`\`\`
**---**
**# 141. Jitter Buffer**
Сразу adaptive.
Хранить:
\`\`\`text
MinimumTarget
CurrentTarget
MaximumTarget
CurrentFill
\`\`\`
**---**
**# 142. Stable network**
\`\`\`text
Target → minimum practical
\`\`\`
**---**
**# 143. Bad network**
\`\`\`text
Target ↑
\`\`\`
но не выше configured max.
**---**
**# 144. Network recovers**
\`\`\`text
Target ↓
\`\`\`
обратно.
**---**
**# 145. Local ClockBridge != Network JitterBuffer**
Никогда не объединять их.
**---**
**# 146. Hidden network buffering audit**
Проверять:
\`\`\`text
Encoder
Packetizer
Transport Queue
Socket Send Buffer
Socket Receive Buffer
JitterBuffer
Decoder
Remote Source Queue
\`\`\`
**---**
**# 147. 1-to-1 room first**
Сначала:
\`\`\`text
User A
↔
User B
\`\`\`
**---**
**# 148. A → B latency**
Измерить отдельно.
**---**
**# 149. B → A latency**
Измерить отдельно.
**---**
**# 150. Network fault injection**
Эмулировать:
\`\`\`text
Loss
Delay
Jitter
Reordering
Duplicates
Burst Loss
Stall
\`\`\`
**---**
**# 151. Long remote sync**
Проверить:
\`\`\`text
1 hour
4 hours
8 hours
\`\`\`
**---**
**# 152. Multi-user room**
Только после стабильного 1-to-1:
\`\`\`text
2
4
8
16
\`\`\`
remote sources.
**---**
**# 153. Один плохой пользователь**
Плохая сеть одного remote participant не должна ухудшать local monitoring и других remote users без причины.
**---**
**# 154. DSP framework**
Теперь добавить интерфейс DSP.
**---**
**# 155. DSP contract**
\`\`\`text
prepare()
process()
reset()
latencyFrames()
\`\`\`
При необходимости:
\`\`\`text
lookaheadFrames()
tailFrames()
\`\`\`
**---**
**# 156. DSP framework можно было спроектировать раньше**
Но реальные DSP stages добавляются только сейчас.
**---**
**# 157. DSP order**
Разумная последовательность:
\`\`\`text
High Pass
↓
EQ
↓
Compressor
↓
Gate / De-esser
↓
Noise Processing
↓
Reverb
↓
Delay
↓
Pitch
\`\`\`
**---**
**# 158. После каждого DSP**
Обязательно:
\`\`\`text
Correctness Test
CPU Test
Latency Measurement
Bypass Test
Reset Test
Failure Test
Baseline Comparison
\`\`\`
**---**
**# 159. Baseline B**
Нормальный local use-case:
\`\`\`text
Capture
↓
Basic DSP
↓
Mixer
↓
Render
\`\`\`
**---**
**# 160. Baseline B должен быть близок к A**
Разница должна объясняться только реальной DSP latency.
**---**
**# 161. Baseline C**
Полная программа:
\`\`\`text
Monitoring ON
Recording ON
Analysis ON
Network ON
Music ON
Remote Voices ON
DSP ON
\`\`\`
**\*\*Явная граница двух фаз:\*\*** в первоначальном плане есть \`Music ON\` и в §163
\`Music Gain\`, но нет контракта загрузки и воспроизведения песни. Реализация
Song Playback относится к фазе II, этапу II.1. Этап 18 основной фазы сохраняет
Baseline C для всех реально построенных к нему источников и отдельно отмечает
отсутствующий Music Source. Полная проверка этого списка с \`Music ON\`, а также
\`Music Gain\`, переносится в этап II.9 после II.1–II.8. Причина переноса —
проверить музыку вместе с остальными источниками только после появления
подготовленного song source; пропуск не считается выполнением требования.
**---**
**# 162. Критический критерий Baseline C**
Local monitoring latency не должна неожиданно вырасти из-за:
\`\`\`text
Recording
Analysis
Network
Diagnostics
\`\`\`
**---**
**# 163. Parameter changes**
Realtime менять:
\`\`\`text
Mic Gain
Monitor Gain
Music Gain
Remote Gain
Master Gain
DSP Parameters
\`\`\`
**---**
**# 164. Parameter smoothing**
Все potentially clicking parameters меняются плавно.
**---**
**# 165. Effect Bypass**
Bypass не должен продолжать скрытую тяжёлую processing работу, если она не требуется для tail policy.
**---**
**# 166. DSP numerical safety**
Проверить:
\`\`\`text
NaN
Infinity
Denormals
Invalid Output
\`\`\`
**---**
**# 167. DSP failure policy**
Для каждого effect определить:
\`\`\`text
Bypass
Disable
SessionFatal
\`\`\`
**---**
**# 168. Hard RT instrumentation**
Test/Debug build должен обнаруживать на RT thread:
\`\`\`text
Heap Allocation
Heap Free
Blocking Mutex
Disk I/O
Network I/O
Blocking IPC
\`\`\`
**---**
**# 169. Любое unexpected RT violation**
\`\`\`text
TEST FAIL
\`\`\`
**---**
**# 170. LatencyRegistry**
Каждый latency-producing stage регистрируется.
Например:
\`\`\`text
Stage Name
Buffered Frames
Algorithmic Latency
Current Fill
\`\`\`
**---**
**# 171. Graph introspection**
AudioService должен возвращать реальный active graph.
Например:
\`\`\`text
Capture
→ InputConversion
→ ClockBridge
→ HPF
→ Compressor
→ Pitch
→ Mixer
→ Limiter
→ Render
\`\`\`
**---**
**# 172. Hidden stage CI check**
Если runtime graph содержит stage, которого нет в expected graph:
\`\`\`text
CI FAIL
\`\`\`
**---**
**# 173. No magic latency constants**
Запрещено:
\`\`\`text
+20 ms
just in case
\`\`\`
Любая задержка:
\`\`\`text
measured
calculated
or explicit policy
\`\`\`
**---**
**# 174. First-audio latency**
Измерять отдельно:
\`\`\`text
StartSession
↓
First audible frame
\`\`\`
**---**
**# 175. Steady-state latency**
Отдельная метрика.
Не смешивать startup latency и monitoring latency.
**---**
**# 176. Audio correctness signals**
Использовать:
\`\`\`text
Silence
Impulse
Sine
Sweep
Golden PCM
\`\`\`
**---**
**# 177. Audio quality checks**
Проверять:
\`\`\`text
Amplitude
Frequency
Phase / Polarity
DC Offset
Clipping
Channel Leakage
Resampler Artifacts
THD+N where useful
\`\`\`
**---**
**# 178. Fuzz State Machine**
Случайные sequences:
\`\`\`text
Start
Stop
Mute
Unmute
RecordStart
RecordStop
Reconfigure
DeviceLost
Recover
Suspend
Resume
\`\`\`
**---**
**# 179. Invariants**
Всегда:
\`\`\`text
QueueFill <= Capacity
SessionFrame monotonic
Sequence monotonic
Old generation cannot mutate new
RuntimeConfiguration comes from opened backend
Invalid timestamp never drives drift estimator
RT never waits for consumer
\`\`\`
**---**
**# 180. Stress Tests**
\`\`\`text
CPU Pressure
Single Core Pressure
Disk Pressure
Memory Pressure
Network Pressure
\`\`\`
**---**
**# 181. DPC / scheduling observation**
На реальном Windows PC измерять:
\`\`\`text
Wake jitter
Deadline misses
Unexpected callback stalls
\`\`\`
**---**
**# 182. Repetition tests**
Fake backend:
\`\`\`text
10 000 Start/Stop
1 000 Reconfiguration
1 000 Recording Start/Stop
\`\`\`
**---**
**# 183. Soak Tests**
\`\`\`text
1 hour during development
8 hours pre-release
24 hours release candidate
\`\`\`
**---**
**# 184. Memory Leak Gate**
Не должно быть постоянного роста:
\`\`\`text
Working Set
Private Bytes
Heap
Audio Buffers
\`\`\`
**---**
**# 185. Handle Leak Gate**
Проверить:
\`\`\`text
Thread Handles
Event Handles
Device Handles
File Handles
COM refs
\`\`\`
**---**
**# 186. Thread Leak Gate**
После Stop thread count возвращается к baseline.
**---**
**# 187. Hardware certification**
Минимальный набор:
\`\`\`text
Realtek Onboard
Cheap USB Sound Card
USB Headset
USB Mic + Separate Output
USB Audio Interface
ASIO Interface
\`\`\`
**---**
**# 188. Самый важный hardware case**
\`\`\`text
USB Microphone
\+
Different Output Device
\`\`\`
Именно здесь настоящий independent-clock drift.
**---**
**# 189. Sample-rate matrix**
Где поддерживается:
\`\`\`text
44100
48000
96000
\`\`\`
**---**
**# 190. Period / buffer matrix**
Для каждого device:
\`\`\`text
Minimum
Next Valid
Preferred / Default
Larger
\`\`\`
**---**
**# 191. Power tests**
\`\`\`text
Balanced
High Performance
Battery
USB Selective Suspend
AC → Battery
Battery → AC
\`\`\`
**---**
**# 192. External Windows changes**
Проверить:
\`\`\`text
Default Device Changed
Device Disabled
Format Changed
Enhancements On / Off
Audio Service Restart
Driver Restart
\`\`\`
**---**
**# 193. Multiple app instances**
Проверить:
\`\`\`text
Shared coexistence
Exclusive contention
ASIO ownership
\`\`\`
**---**
**# 194. Driver lies**
Fake backend должен симулировать:
\`\`\`text
Capabilities != Runtime
Clock goes backwards
Oversized packet
Callback after close
Wrong latency
Unexpected format
\`\`\`
**---**
**# 195. Backend hangs**
Симулировать:
\`\`\`text
Open hangs
Start hangs
Stop hangs
Reset hangs
\`\`\`
Control plane должен получить timeout/failure state.
**---**
**# 196. Shutdown model**
Каждый worker должен иметь deterministic shutdown:
\`\`\`text
Stop Accepting Work
↓
Drain or Cancel
↓
Join
↓
Destroy
\`\`\`
**---**
**# 197. Shutdown timeouts**
Driver/backend не должен иметь возможность держать service вечно.
**---**
**# 198. audio-dump final**
Должен показывать:
\`\`\`text
Service State
Session State
generationId
Backend
Device IDs
Driver Versions
RequestedConfiguration
RuntimeConfiguration
Sample Rates
Periods
Endpoint Buffers
Current Padding
Clock Domains
Drift ppm
Correction Ratio
ClockBridge Fill / Target
Signal Graph
Active DSP
DSP Latencies
Active Resamplers
Active Queues
Queue Fill
XRuns
Deadline Misses
Local Estimated Latency
Local Measured Latency
First-Audio Latency
Network Jitter Buffer
Remote Estimated Latency
\`\`\`
**---**
**# 199. Baselines**
Для каждого release хранить:
\`\`\`text
Baseline A:
Bare Engine
Baseline B:
Normal Local DSP
Baseline C:
Full Application
Remote A → B
Remote B → A
\`\`\`
**---**
**# 200. Regression policy**
Необъяснимый рост:
\`\`\`text
Latency
CPU
XRuns
Memory
Clock instability
Startup latency
\`\`\`
блокирует release.
**---**
**# 201. Error snapshots**
При серьёзной ошибке сохранять:
\`\`\`text
Device ID
Driver Version
Backend
Requested
Runtime
Period
Endpoint Buffer
Current Padding
Clock Drift
Correction Ratio
Queue Fills
DSP Latency
DSP CPU
XRuns
Deadline Misses
generationId
\`\`\`
**---**
**# 202. Trace replay**
Сохранять обезличенный timing/event trace без PCM.
Например:
\`\`\`text
Callbacks
Positions
Timestamps
Periods
Device Events
Network Events
\`\`\`
Потом replay через FakeBackend.
**---**
**# 203. Device-specific workarounds**
Хранить отдельно:
\`\`\`text
Device ID
Driver Version
Known Issue
Workaround
Reason
\`\`\`
Не размазывать hacks по core engine.
**---**
**# 204. Feature flags**
Для сложных частей:
\`\`\`text
AdaptiveResampling
RAWMode
AdvancedDSP
SpecificDriverWorkaround
\`\`\`
**---**
**# 205. Build profiles**
Минимум:
\`\`\`text
Debug
Instrumented/Test
Release
\`\`\`
Тяжёлые diagnostic assertions не должны случайно попасть в realtime release hot path.
**---**
**# 206. PR discipline**
Не менять одновременно без необходимости:
\`\`\`text
Clock Sync
Mixer
Network Jitter
DSP
Backend lifecycle
\`\`\`
в одном огромном PR.
**---**
**# 207. Profiling hot path**
Отдельно измерять:
\`\`\`text
Capture Handling
Boundary Conversion
Resampling
DSP
Mix
Render Submission
\`\`\`
**---**
**# 208. Новая функция не считается готовой без**
\`\`\`text
Implementation
Automated Tests
Diagnostics
Latency Impact
CPU Impact
Ownership/Lifetime Review
Threading Review
Failure Behaviour
Recovery Behaviour
\`\`\`
**---**
**# 209. Gate каждого этапа**
Каждый этап проходит:
\`\`\`text
IMPLEMENT
↓
FUNCTIONAL TEST
↓
REALTIME TEST
↓
FAILURE TEST
↓
LATENCY MEASUREMENT
↓
CPU MEASUREMENT
↓
MEMORY CHECK
↓
OWNERSHIP CHECK
↓
THREADING CHECK
↓
DIAGNOSTICS CHECK
↓
BASELINE COMPARISON
↓
PASS
\`\`\`
**---**
**# 210. Release blockers**
Release запрещён при:
\`\`\`text
Crash
Deadlock
Use-After-Free
Memory Corruption
Memory Leak
Thread Leak
Handle Leak
Unbounded Queue
Unbounded ClockBridge
Unbounded JitterBuffer
Unexpected RT Allocation
Unexpected RT Free
Blocking Operation on RT Thread
Hidden Buffer
Hidden Resampler
Hidden DSP
Hidden Conversion
Silent Recording Data Loss
Incorrect Recording Duration
Incorrect RuntimeConfiguration
Old PCM After Recovery
Stale Generation Callback
Uncontrolled Drift
ClockBridge Creep
JitterBuffer Creep
Remote Latency Creep
Local Latency Regression
Remote Latency Regression
Unexplained XRuns
Incorrect Diagnostics
\`\`\`
**---**
**# 211. Reliability release gate**
Минимум:
\`\`\`text
10 000 Start/Stop cycles
1 000 Reconfiguration cycles
1 000 Recording Start/Stop cycles
Device-loss fault injection
Backend hang tests
Network-loss tests
CPU stress
Disk stress
Memory pressure
8-hour automated soak
24-hour release-candidate soak
Physical loopback
Multi-user room test
\`\`\`
**---**
**# 212. Итоговый порядок реализации**
\`\`\`text
1\. AudioService Process
2\. Service Lifecycle
3\. IPC + Protocol Version
4\. Session State Machine
5\. generationId
6\. Ownership Model
7\. Threading Model
8\. Error Model
9\. Diagnostics Foundation
10\. TraceBuffer
11\. SessionSnapshot
12\. audio-dump Foundation
13\. IAudioBackend
14\. FakeAudioBackend
15\. Configuration Models
16\. DeviceManager
17\. RealtimeBufferPool
18\. AudioBlock
19\. Bare SignalGraph
20\. Mixer
21\. ClockSynchronizer
22\. Fake Clock Tests
23\. Fault Injection Foundation
24\. WASAPI Shared
25\. Bare Capture → Monitor → Render
26\. Software Latency Measurement
27\. Physical Loopback Measurement
28\. WASAPI Shared Tuning
29\. Device Loss / Recovery
30\. Reconfiguration
31\. Sleep / Resume
32\. Long Drift Test
33\. Shared Soak
34\. WASAPI Exclusive
35\. Exclusive Tests / Latency Baseline
36\. ASIO
37\. ASIO Duplex / Driver Tests
38\. Cross-Backend Certification
39\. Recording
40\. Analysis
41\. Network Send
42\. Network Receive
43\. Adaptive Jitter Buffer
44\. 1-to-1 Room
45\. Remote Latency Measurement
46\. Network Fault Injection
47\. Long Remote Synchronization
48\. Multi-user Room
49\. DSP Framework
50\. DSP Effects One-by-One
51\. Baseline B
52\. Full Application Baseline C
53\. Hard RT Instrumentation
54\. LatencyRegistry
55\. Graph Introspection
56\. State Fuzzing
57\. Stress Testing
58\. Repetition Testing
59\. Hardware Certification
60\. 1-hour Soak
61\. 8-hour Soak
62\. 24-hour Release Soak
63\. Final Physical Loopback
64\. Final Room Latency Test
65\. Release Gates
\`\`\`
**---**
**# 213. Главная стратегия**
Вся разработка должна идти так:
\`\`\`text
BUILD SMALL
↓
PROVE IT WORKS
↓
MEASURE IT
↓
UNDERSTAND ITS FAILURE MODES
↓
FREEZE A BASELINE
↓
ADD ONE THING
↓
REPEAT
\`\`\`
**---**
**# 214. Главный критерий качества**
Сервис считается хорошим не тогда, когда:
\`\`\`text
“звук вроде есть”
\`\`\`
а когда доказано:
\`\`\`text
минимальная practical latency
stable runtime configuration
bounded clocks
bounded queues
no hidden buffering
no RT blocking
no stale callbacks
predictable recovery
accurate diagnostics
reproducible failures
stable long-running behaviour
\`\`\`
**---**
**# 215. Финальный принцип проекта**
Любой новый:
\`\`\`text
Buffer
Queue
Resampler
DSP
Codec Stage
Thread
Async Operation
\`\`\`
обязан отвечать на вопросы:
\`\`\`text
Зачем он нужен?
Кто им владеет?
На каком thread он работает?
Сколько memory использует?
Сколько frames хранит?
Сколько latency добавляет?
Как диагностируется?
Как тестируется?
Что происходит при failure?
Как восстанавливается?
Может ли он повлиять на RT path?
\`\`\`
Если ответов нет — компонент ещё не готов к AudioService.