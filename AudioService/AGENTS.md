**# Эталонные правила архитектуры и кода AudioService**
**## 1. Главный принцип**
Код должен быть:
\`\`\`text
простой
↓
явный
↓
маленький
↓
предсказуемый
↓
тестируемый
↓
измеримый
\`\`\`
Не:
\`\`\`text
универсальный на все случаи жизни
↓
абстрактный
↓
многоуровневый
↓
магический
\`\`\`
Главное правило:
\> Не добавлять сущность, пока без неё реально нельзя.
**---**
**# 2. Не проектировать «на будущее»**
Запрещено создавать заранее:
\`\`\`text
Manager
Factory
Provider
Resolver
Coordinator
Controller
Registry
Strategy
Adapter
Facade
Builder
\`\`\`
только потому, что «когда-нибудь пригодится».
Сначала появляется реальная потребность.
Потом минимальное решение.
**---**
**# 3. Одна ответственность — один модуль**
Например:
\`\`\`text
DeviceManager
→ только устройства
WasapiBackend
→ только WASAPI
ClockSynchronizer
→ только clocks/drift
Mixer
→ только mixing
RecordingWriter
→ только запись файла
\`\`\`
Нельзя:
\`\`\`text
AudioManager
\`\`\`
который делает:
\`\`\`text
devices
audio
recording
network
DSP
settings
diagnostics
\`\`\`
**---**
**# 4. Но не дробить слишком сильно**
SRP не означает:
\`\`\`text
1 функция = 1 файл
\`\`\`
Если маленькие функции принадлежат одной ответственности — держать вместе.
Плохо:
\`\`\`text
CalculatePadding.cpp
CalculateAvailableFrames.cpp
CalculatePeriod.cpp
\`\`\`
Хорошо:
\`\`\`text
WasapiRender.cpp
\`\`\`
если эти функции являются частью одного render lifecycle.
**---**
**# 5. Размер файла — сигнал, а не закон**
Ориентир:
\`\`\`text
100–300 строк
\`\`\`
обычно нормально.
\`\`\`text
300–500
\`\`\`
требует проверки.
\`\`\`text
500+
\`\`\`
почти всегда повод посмотреть, не смешаны ли ответственности.
Но не надо разбивать хороший 520-строчный cohesive backend на 12 бессмысленных файлов только ради лимита.
**---**
**# 6. Размер функции**
Обычно:
\`\`\`text
5–30 строк
\`\`\`
Нормально.
Если функция становится:
\`\`\`text
50–100+
\`\`\`
нужно проверить, не делает ли она несколько вещей.
Но важнее:
\`\`\`text
одна понятная задача
\`\`\`
чем искусственный line limit.
**---**
**# 7. Максимум один уровень абстракции внутри функции**
Плохо:
\`\`\`cpp
openDevice();
calculateBuffer();
parseDriver();
allocateMemory();
startThread();
writeRegistry();
\`\`\`
если функция называется:
\`\`\`cpp
startSession()
\`\`\`
и внутри смешивает всё.
Лучше:
\`\`\`cpp
void AudioSession::start() {
    openBackend();
    prepareRuntime();
    startBackend();
}
\`\`\`
А детали живут там, где им положено.
**---**
**# 8. Не делать wrapper ради wrapper**
Плохо:
\`\`\`text
AudioDeviceManager
↓
AudioDeviceService
↓
AudioDeviceProvider
↓
WasapiDeviceProvider
↓
WasapiDeviceEnumerator
\`\`\`
если вся задача — вызвать MMDevice API.
Лучше:
\`\`\`text
DeviceManager
↓
WasapiDeviceEnumerator
\`\`\`
И даже второй класс нужен только если реально есть смысл.
**---**
**# 9. Максимум 2–3 архитектурных уровня**
Для обычной операции путь должен быть понятен быстро.
Например:
\`\`\`text
SessionManager
↓
AudioSession
↓
IAudioBackend
\`\`\`
Не:
\`\`\`text
SessionController
↓
SessionService
↓
SessionCoordinator
↓
SessionFacade
↓
BackendResolver
↓
BackendFactory
↓
BackendAdapter
\`\`\`
**---**
**# 10. Composition вместо inheritance**
Предпочитать:
\`\`\`cpp
class AudioSession {
    std::unique\_ptr\<IAudioBackend> backend\_;
    Mixer mixer\_;
    ClockSynchronizer clocks\_;
};
\`\`\`
а не большие hierarchy:
\`\`\`text
BaseAudioSession
↓
WindowsAudioSession
↓
LowLatencyWindowsAudioSession
↓
WasapiLowLatencyAudioSession
\`\`\`
**---**
**# 11. Наследование только для настоящего полиморфизма**
Хороший пример:
\`\`\`text
IAudioBackend
FakeAudioBackend
WasapiBackend
AsioBackend
\`\`\`
Потому что они реально реализуют один contract разными способами.
**---**
**# 12. Не делать interface для каждого класса**
Не нужно:
\`\`\`text
IMixer
Mixer
IClockSynchronizer
ClockSynchronizer
IRecordingWriter
RecordingWriter
\`\`\`
если существует только одна реализация и интерфейс ничего не даёт.
Interface нужен когда:
\`\`\`text
есть несколько реализаций
\`\`\`
или:
\`\`\`text
есть настоящая test boundary
\`\`\`
**---**
**# 13. Ownership всегда очевиден**
Использовать:
\`\`\`text
unique ownership by default
\`\`\`
В C++:
\`\`\`cpp
std::unique\_ptr
\`\`\`
только когда heap ownership действительно нужен.
Не разбрасывать:
\`\`\`cpp
std::shared\_ptr
\`\`\`
по всему проекту.
**---**
**# 14. shared\_ptr — исключение**
\`shared\_ptr\` часто скрывает неправильный lifecycle.
Если непонятно:
\`\`\`text
кто должен уничтожить объект?
\`\`\`
не надо решать проблему через shared\_ptr.
Нужно исправить ownership.
**---**
**# 15. Raw pointer может быть нормальным**
Raw pointer/reference допустим как:
\`\`\`text
non-owning view
\`\`\`
Например:
\`\`\`cpp
Mixer(AudioBufferPool& pool);
\`\`\`
Это часто лучше, чем shared\_ptr.
**---**
**# 16. RAII везде**
Любой resource:
\`\`\`text
COM object
handle
event
thread
file
backend
buffer
\`\`\`
должен иметь deterministic lifetime.
Не писать ручные:
\`\`\`text
open()
...
если ошибка goto cleanup
...
close()
\`\`\`
там, где можно RAII.
**---**
**# 17. Runtime state не дублировать**
Не держать одновременно:
\`\`\`text
sessionRunning\_
backendRunning\_
audioActive\_
started\_
isPlaying\_
streamOpen\_
\`\`\`
если они означают одно и то же.
Один authoritative state.
**---**
**# 18. Не плодить boolean state**
Особенно плохо:
\`\`\`cpp
bool opening;
bool running;
bool stopping;
bool recovering;
bool failed;
\`\`\`
Можно получить невозможное:
\`\`\`text
running = true
stopping = true
recovering = true
\`\`\`
Использовать:
\`\`\`cpp
enum class SessionState
\`\`\`
**---**
**# 19. Strong types для разных сущностей**
Не использовать везде:
\`\`\`cpp
uint64\_t
\`\`\`
если значения имеют разный смысл.
Например концептуально:
\`\`\`text
SessionFrame
DevicePosition
GenerationId
SequenceNumber
\`\`\`
должны быть различимы хотя бы через типы или аккуратные структуры.
**---**
**# 20. Единицы измерения в имени**
Хорошо:
\`\`\`cpp
sampleRateHz
periodFrames
latencyFrames
latencyMs
timeoutMs
bufferBytes
\`\`\`
Плохо:
\`\`\`cpp
rate
size
latency
timeout
\`\`\`
**---**
**# 21. Frames — основная audio unit**
В realtime core использовать:
\`\`\`text
frames
\`\`\`
Не переводить постоянно:
\`\`\`text
frames → ms → frames → seconds → frames
\`\`\`
Milliseconds — UI/diagnostics.
**---**
**# 22. Immutable configuration**
После создания:
\`\`\`text
RequestedConfiguration
RuntimeConfiguration
FinalSessionPlan
\`\`\`
лучше рассматривать как immutable snapshots.
Не менять их по полям из разных потоков.
Новая конфигурация:
\`\`\`text
new object
\`\`\`
**---**
**# 23. Snapshot вместо mutable global state**
Control thread формирует:
\`\`\`text
ParameterSnapshot
\`\`\`
Realtime thread читает консистентную версию.
Не обновлять 20 отдельных параметров в случайном порядке.
**---**
**# 24. Никаких глобальных mutable singleton**
Запрещать:
\`\`\`cpp
AudioManager::instance()
GlobalAudioState
GlobalMixer
GlobalSettings
\`\`\`
Dependencies передаются явно.
**---**
**# 25. Dependency injection должна быть простой**
Не нужен DI framework.
Нормально:
\`\`\`cpp
AudioSession(
    std::unique\_ptr\<IAudioBackend> backend,
    Diagnostics& diagnostics
);
\`\`\`
**---**
**# 26. Минимум dependencies у класса**
Если constructor принимает:
\`\`\`text
12–20 dependencies
\`\`\`
почти наверняка класс делает слишком много.
**---**
**# 27. Не делать God Object**
\`AudioSession\` может координировать компоненты.
Но не должна сама реализовывать:
\`\`\`text
WASAPI
resampling
DSP
recording file I/O
network protocol
device enumeration
\`\`\`
**---**
**# 28. Coordinator не должен делать работу компонентов**
Хорошо:
\`\`\`cpp
session.start();
backend.start();
\`\`\`
Плохо:
\`\`\`cpp
AudioSession::start()
\`\`\`
содержит 500 строк WASAPI COM-кода.
**---**
**# 29. Backend owns backend-specific complexity**
Все такие вещи:
\`\`\`text
HRESULT
COM interfaces
WASAPI flags
ASIO messages
driver quirks
\`\`\`
не должны вытекать в core.
Core работает с:
\`\`\`text
BackendError
RuntimeConfiguration
AudioBlock
\`\`\`
**---**
**# 30. Core не знает WASAPI/ASIO**
Нельзя:
\`\`\`cpp
if (backend == WASAPI) ...
else if (backend == ASIO) ...
\`\`\`
по всему проекту.
Эта логика должна оставаться внутри backend boundary.
**---**
**# 31. Минимум public API**
Public interface класса должен быть маленьким.
Например Mixer:
\`\`\`text
prepare
setSnapshot
process
reset
\`\`\`
Не 35 методов.
**---**
**# 32. Не открывать поля без необходимости**
State меняется через понятные операции.
Не:
\`\`\`cpp
session.state = ...
session.backend = ...
session.buffer = ...
\`\`\`
из любых мест.
**---**
**# 33. Command-query separation**
Функция либо:
\`\`\`text
меняет состояние
\`\`\`
либо:
\`\`\`text
возвращает данные
\`\`\`
По возможности не оба сразу.
**---**
**# 34. Функция должна иметь понятное имя**
Хорошо:
\`\`\`cpp
readRuntimeConfiguration()
calculateFramesAvailable()
drainCapturePackets()
resetClockMapping()
\`\`\`
Плохо:
\`\`\`cpp
handleAudio()
processStuff()
updateAll()
doWork()
\`\`\`
**---**
**# 35. Не использовать \`handle\` для всего**
Если можно сказать точнее — сказать точнее.
Вместо:
\`\`\`cpp
handleDevice()
\`\`\`
лучше:
\`\`\`cpp
recoverLostDevice()
\`\`\`
**---**
**# 36. Boolean arguments избегать**
Плохо:
\`\`\`cpp
open(true, false, true);
\`\`\`
Лучше:
\`\`\`cpp
OpenOptions{
    .exclusive = true,
    .rawMode = false
};
\`\`\`
**---**
**# 37. Magic numbers запрещены**
Не:
\`\`\`cpp
queue.resize(17);
sleep(3);
buffer += 256;
\`\`\`
Все значения:
\`\`\`text
named constant
configuration
runtime capability
\`\`\`
**---**
**# 38. Magic latency запрещена особенно**
Никаких:
\`\`\`text
+10 ms safety
+20 ms just in case
\`\`\`
Любая buffering policy должна иметь объяснение.
**---**
**# 39. Не кэшировать производные данные без необходимости**
Если значение дешёво вычислить:
\`\`\`text
framesAvailable = buffer - padding
\`\`\`
не нужно хранить ещё один mutable:
\`\`\`text
framesAvailable\_
\`\`\`
который может рассинхронизироваться.
**---**
**# 40. Не хранить одно и то же дважды**
Например:
\`\`\`text
periodFrames
periodMs
\`\`\`
не нужно хранить оба как mutable state.
Хранить frames.
ms вычислять.
**---**
**# 41. Отдельные read-only DTO для IPC**
Не отдавать frontend internal C++ classes напрямую.
Использовать маленькие:
\`\`\`text
ServiceStateDto
DeviceDto
SessionDiagnosticsDto
\`\`\`
**---**
**# 42. IPC schema должен быть стабильным**
Не позволять внутреннему refactoring автоматически ломать frontend contract.
**---**
**# 43. Realtime код максимально линейный**
Идеальный hot path читается сверху вниз:
\`\`\`text
read
convert
process
mix
write
\`\`\`
Не десятки callbacks/delegates/virtual hops на каждый sample block.
**---**
**# 44. Не использовать event bus внутри realtime**
Не:
\`\`\`text
Capture event
→ EventBus
→ Subscriber
→ Handler
→ Dispatcher
→ DSP
\`\`\`
Прямой вызов намного лучше.
**---**
**# 45. Virtual dispatch — только на coarse boundaries**
Например:
\`\`\`text
IAudioBackend
IAudioProcessor
\`\`\`
допустимы.
Не делать virtual function для каждого sample/channel.
**---**
**# 46. Не использовать std::function в hot path без причины**
Особенно если она может выделять память или скрывать indirect call.
**---**
**# 47. Не использовать streams/string formatting в RT**
Не:
\`\`\`cpp
std::stringstream
std::format
std::cout
\`\`\`
в callback.
**---**
**# 48. Логи в RT — только события/counters**
Например:
\`\`\`text
xrunCount++
\`\`\`
или запись фиксированного event struct.
**---**
**# 49. Все queues bounded**
Никакой:
\`\`\`cpp
std::queue
\`\`\`
которая может расти бесконечно.
Всегда известны:
\`\`\`text
capacity
overflow policy
\`\`\`
**---**
**# 50. Overflow policy рядом с queue**
Не искать её где-то в SessionManager.
Например:
\`\`\`text
RecordingQueue
policy = ReportGap
\`\`\`
**---**
**# 51. Не копировать PCM без причины**
Если один block нужен:
\`\`\`text
Recording
Analysis
Network
\`\`\`
по возможности передавать prepared block/view/handle.
Не делать три полных memcpy без необходимости.
**---**
**# 52. Но zero-copy не делать религией**
Если zero-copy сильно усложняет lifetime — иногда один bounded memcpy лучше 10 классов reference counting.
Простота важнее микрооптимизации, пока profiling не доказал обратное.
**---**
**# 53. Оптимизация только после измерения**
Не писать SIMD, custom allocator или lock-free monster заранее.
Сначала profiling.
**---**
**# 54. Но realtime invariants проектировать сразу**
Это не premature optimization:
\`\`\`text
no allocation
bounded queues
no blocking
\`\`\`
Это fundamental correctness.
**---**
**# 55. DSP pipeline должен быть data-driven, но простой**
Например:
\`\`\`cpp
std::array\<IAudioProcessor\*, MaxProcessors>
\`\`\`
или другой bounded набор.
Не создавать сложную graph framework, если pipeline линейный.
**---**
**# 56. Не делать универсальный DAG заранее**
Если сейчас:
\`\`\`text
Input → DSP → Mixer → Output
\`\`\`
не нужен generic node editor engine.
Добавить DAG только если реальная функция потребует branching/routing.
**---**
**# 57. DSP node маленький и самостоятельный**
Каждый effect отвечает только за:
\`\`\`text
prepare
process
reset
latency
\`\`\`
Не знает Recording/Network/UI.
**---**
**# 58. Mixer не знает network**
Mixer получает:
\`\`\`text
audio sources
\`\`\`
Ему не важно:
\`\`\`text
local
network
file
\`\`\`
**---**
**# 59. Recording не знает WASAPI**
Он получает AudioBlock.
Не должен вызывать backend.
**---**
**# 60. Network не знает Mixer internals**
Network получает конкретный tap/source.
**---**
**# 61. Diagnostics не управляет engine**
Diagnostics наблюдает.
Не:
\`\`\`text
если diagnostic counter высокий,
Diagnostics увеличивает buffer
\`\`\`
Policy принимает Session/Control layer.
**---**
**# 62. Tests mirror production boundaries**
Структура tests должна повторять архитектуру.
Например:
\`\`\`text
tests/
  session/
  backend/
  clock/
  mixer/
  recording/
  network/
  dsp/
\`\`\`
Не один:
\`\`\`text
tests.cpp
\`\`\`
на 8000 строк.
**---**
**# 63. Один test — одна причина падения**
Плохо:
\`\`\`text
testEverythingWorks()
\`\`\`
который проверяет 40 условий.
Хорошо:
\`\`\`text
requestedPeriodIsPreserved()
runtimePeriodComesFromBackend()
oldGenerationCallbackIsIgnored()
\`\`\`
**---**
**# 64. Название теста описывает поведение**
Формат:
\`\`\`text
given\_when\_then
\`\`\`
или читаемая фраза.
Например:
\`\`\`text
runningSessionIgnoresCallbackFromPreviousGeneration
\`\`\`
**---**
**# 65. Не тестировать implementation details**
Проверять:
\`\`\`text
observable behaviour
contract
invariants
\`\`\`
Не:
\`\`\`text
сколько приватных функций было вызвано
\`\`\`
**---**
**# 66. Минимум mocks**
Большое количество mocks делает тесты хрупкими.
Предпочитать:
\`\`\`text
FakeAudioBackend
FakeClock
FakeWriter
FakeNetwork
\`\`\`
с реальным поведением.
**---**
**# 67. Fake лучше mock для сложных subsystem**
Fake backend способен:
\`\`\`text
генерировать packets
drift
errors
\`\`\`
Mock только проверяет:
\`\`\`text
метод вызван N раз
\`\`\`
Для audio engine fake намного полезнее.
**---**
**# 68. Test fixtures маленькие**
Не создавать гигантский:
\`\`\`text
AudioTestBase
\`\`\`
со 100 helper functions.
Лучше маленькие helpers рядом с domain.
**---**
**# 69. Test builders только если уменьшают шум**
Например:
\`\`\`cpp
auto session = TestSession::minimal();
\`\`\`
Нормально.
Но не:
\`\`\`text
SessionFixtureFactoryBuilderProvider
\`\`\`
**---**
**# 70. Arrange / Act / Assert**
Каждый test визуально:
\`\`\`text
Arrange
Act
Assert
\`\`\`
Без огромной setup-магии.
**---**
**# 71. Test data должна быть очевидной**
Использовать:
\`\`\`text
48'000 Hz
128 frames
144 frames
+25 ppm
\`\`\`
чтобы легко читать test.
**---**
**# 72. Не использовать случайность без seed**
Fuzz/property test должен сохранять seed.
Любой failure должен быть воспроизводим.
**---**
**# 73. Каждый bug → regression test**
Правило без исключений.
Нашёл:
\`\`\`text
30 sec → 1 sec recording
\`\`\`
сначала создать тест.
Потом исправлять.
**---**
**# 74. Snapshot/golden tests использовать осторожно**
Хороши для:
\`\`\`text
known PCM output
graph dump
IPC schema
\`\`\`
Но не заменяют semantic assertions.
**---**
**# 75. Не плодить helper assertion**
Хорошо:
\`\`\`cpp
EXPECT\_EQ(...)
\`\`\`
Если появляется 30 custom macros — тесты становятся новым framework.
**---**
**# 76. Общие test helpers должны быть очень маленькими**
Например:
\`\`\`text
makeSine()
makeImpulse()
framesToMs()
\`\`\`
**---**
**# 77. Integration tests отдельно от unit tests**
Unit:
\`\`\`text
milliseconds
\`\`\`
Integration:
\`\`\`text
seconds
\`\`\`
Hardware:
\`\`\`text
manual/CI agent
\`\`\`
Не смешивать.
**---**
**# 78. Hardware tests не должны ломать обычный CI**
Разделить labels:
\`\`\`text
unit
integration
hardware
soak
stress
\`\`\`
**---**
**# 79. Никакой копипасты между backend tests**
Создать backend contract suite.
Один набор contract tests должен запускаться для:
\`\`\`text
Fake
WASAPI Shared
WASAPI Exclusive
ASIO
\`\`\`
где это возможно.
**---**
**# 80. Но backend-specific tests остаются отдельно**
Например:
\`\`\`text
WASAPI padding
ASIO bufferSwitch
\`\`\`
не надо искусственно запихивать в общий contract.
**---**
**# 81. Комментарии только зачем**
Плохо:
\`\`\`cpp
// increment counter
counter++;
\`\`\`
Хорошо:
\`\`\`cpp
// Ignore stale callbacks because ASIO drivers may call back during teardown.
\`\`\`
**---**
**# 82. Код должен объяснять «что»**
Комментарии объясняют:
\`\`\`text
почему
\`\`\`
и:
\`\`\`text
какой внешний constraint
\`\`\`
**---**
**# 83. TODO запрещать без причины**
Не:
\`\`\`cpp
// TODO fix later
\`\`\`
Если TODO нужен:
\`\`\`text
issue/reference
reason
\`\`\`
**---**
**# 84. Dead code удалять**
Не оставлять:
\`\`\`text
OldMixer
NewMixer
MixerV2
MixerFinal
\`\`\`
Git уже хранит историю.
**---**
**# 85. Никаких V2/V3/Final в названиях**
Запрещать:
\`\`\`text
AudioSession2
WasapiBackendNew
ClockSyncFinal
RecordingManagerV3
\`\`\`
Всегда должна существовать одна актуальная реализация.
**---**
**# 86. Старую реализацию удалять в том же PR**
После migration.
Не держать:
\`\`\`text
legacy path
new path
temporary path
\`\`\`
месяцами.
**---**
**# 87. Feature flags временные — с owner и сроком**
Если flag нужен для migration:
\`\`\`text
название
причина
когда удалить
\`\`\`
**---**
**# 88. Не делать «compatibility forever»**
IPC versioning — да.
Внутренние deprecated APIs — удалять быстро.
**---**
**# 89. Naming consistency**
Один термин во всём проекте.
Если выбрали:
\`\`\`text
RuntimeConfiguration
\`\`\`
не использовать рядом:
\`\`\`text
ActualConfig
ActiveConfig
RealConfig
\`\`\`
**---**
**# 90. Одинаковые глаголы**
Например:
\`\`\`text
prepare
start
stop
reset
close
\`\`\`
Не:
\`\`\`text
initialize
setup
prepare
configure
prime
\`\`\`
для одинакового действия в разных классах.
**---**
**# 91. \`prepare\` имеет конкретный смысл**
Например:
\`\`\`text
allocate/configure resources
but do not start realtime processing
\`\`\`
И этот смысл одинаков везде.
**---**
**# 92. \`reset\` тоже**
Например:
\`\`\`text
clear internal runtime state
keep configuration
\`\`\`
**---**
**# 93. \`close\`**
\`\`\`text
release external resources
\`\`\`
**---**
**# 94. Public contracts документировать**
Особенно:
\`\`\`text
thread safety
ownership
realtime safety
valid states
\`\`\`
Например:
\`\`\`text
process()
RT-safe
noexcept
no allocation
\`\`\`
**---**
**# 95. Использовать noexcept на RT boundaries**
Где contract это позволяет.
Это и документация, и защита.
**---**
**# 96. const correctness**
Если объект не меняется:
\`\`\`cpp
const
\`\`\`
Это уменьшает количество возможных состояний.
**---**
**# 97. Минимизировать mutable state**
Чем меньше mutable fields — тем меньше race bugs.
**---**
**# 98. Atomic использовать только когда нужна**
Не делать:
\`\`\`cpp
std::atomic
\`\`\`
на всё подряд.
Atomic не исправляет плохой ownership/threading design.
**---**
**# 99. Один writer предпочтительнее**
Для shared state стараться использовать:
\`\`\`text
single writer
multiple readers
\`\`\`
Например Session state меняет control thread.
**---**
**# 100. Realtime thread не управляет lifecycle**
RT callback не должен:
\`\`\`text
open device
recover session
start recording worker
\`\`\`
Он только сигнализирует:
\`\`\`text
error/event
\`\`\`
Control thread принимает решение.
**---**
**# 101. Error handling явный**
Не проглатывать:
\`\`\`cpp
catch (...) {}
\`\`\`
Не возвращать \`false\` без причины.
Использовать понятные error types/status.
**---**
**# 102. HRESULT не растаскивать по core**
Преобразовать на backend boundary:
\`\`\`text
HRESULT
↓
BackendError
\`\`\`
**---**
**# 103. Error messages actionable**
Не:
\`\`\`text
Audio failed
\`\`\`
Лучше:
\`\`\`text
Requested WASAPI Shared period 128 is below device minimum 144 frames
\`\`\`
**---**
**# 104. Нет логики в getters**
Getter не должен:
\`\`\`text
открывать device
пересчитывать graph
менять state
\`\`\`
**---**
**# 105. Constructors лёгкие**
Constructor устанавливает invariants.
Не запускает:
\`\`\`text
threads
devices
network
\`\`\`
Для этого есть явные lifecycle operations.
**---**
**# 106. Не использовать Service Locator**
Dependencies должны быть видны из constructor/owner tree.
**---**
**# 107. Folder structure по domain, не по типу**
Лучше:
\`\`\`text
backend/
clock/
recording/
network/
diagnostics/
\`\`\`
чем:
\`\`\`text
interfaces/
managers/
services/
helpers/
utils/
\`\`\`
**---**
**# 108. \`utils\` почти запретить**
\`utils/\` быстро становится мусоркой.
Helper должен жить рядом с domain.
**---**
**# 109. \`common/\` тоже ограничить**
В common идут только действительно фундаментальные вещи:
\`\`\`text
strong types
small math helpers
result/error primitives
\`\`\`
**---**
**# 110. Helpers должны быть pure**
По возможности:
\`\`\`text
input → output
\`\`\`
без hidden global state.
**---**
**# 111. Не создавать generic framework внутри проекта**
Ты пишешь AudioService, а не библиотеку для всех audio products мира.
Оптимизировать архитектуру под реальную задачу.
**---**
**# 112. YAGNI**
Если функция не нужна текущему roadmap:
\`\`\`text
не писать
\`\`\`
**---**
**# 113. KISS**
Если две реализации работают одинаково, выбрать более простую.
**---**
**# 114. DRY применять разумно**
Не всякое повторение плохо.
Две простые похожие функции иногда лучше, чем:
\`\`\`text
UniversalGenericAudioOperation\<TBackend, TMode, TPolicy>
\`\`\`
**---**
**# 115. Правило трёх**
Не создавать abstraction после первого повторения.
Если одинаковая логика появляется 3 раза и действительно одна по смыслу — тогда выносить.
**---**
**# 116. Не делать premature deduplication**
Особенно между:
\`\`\`text
WASAPI
ASIO
\`\`\`
Похожий код может иметь разные driver semantics.
**---**
**# 117. Cyclomatic complexity контролировать**
Большие:
\`\`\`text
if / else if / switch
\`\`\`
часто означают смешение ответственности.
Но state machine switch может быть абсолютно нормальным.
**---**
**# 118. Early return**
Предпочитать:
\`\`\`cpp
if (!valid) return error;
\`\`\`
вместо 8 уровней вложенности.
**---**
**# 119. Максимум 2–3 уровня nesting**
Обычно.
Глубокая вложенность ухудшает realtime-код особенно сильно.
**---**
**# 120. Avoid clever code**
Не писать код, который надо «разгадывать».
В audio core лучше:
\`\`\`text
5 очевидных строк
\`\`\`
чем:
\`\`\`text
1 гениальный template expression
\`\`\`
**---**
**# 121. Templates использовать там, где реально нужны**
Например fixed-size structures — нормально.
Но не превращать AudioService в template metaprogramming project.
**---**
**# 122. Macros минимизировать**
Особенно бизнес/аудио логику.
Допустимы platform/compiler helpers.
**---**
**# 123. Compile-time boundaries полезны**
Backend-specific headers не должны расползаться.
Например WASAPI COM headers не должны быть нужны Mixer.
**---**
**# 124. PCH не скрывает плохие dependencies**
Даже если всё быстро компилируется, include graph должен быть чистым.
**---**
**# 125. Forward declarations где разумно**
Снижать coupling.
**---**
**# 126. CI должен запрещать warnings**
Production target:
\`\`\`text
warnings as errors
\`\`\`
после настройки разумного warning set.
**---**
**# 127. Static analysis обязателен**
Особенно:
\`\`\`text
lifetime
bounds
uninitialized state
integer conversion
threading
\`\`\`
**---**
**# 128. clang-format автоматически**
Один формат для всего проекта.
Никаких ручных споров о пробелах.
**---**
**# 129. clang-tidy / MSVC analysis**
Настроить постепенно, но серьёзные warnings не игнорировать.
**---**
**# 130. Code review checklist**
Каждый PR проверяется:
\`\`\`text
Новая abstraction действительно нужна?
Можно ли удалить код?
Нет ли duplicate state?
Понятен ли ownership?
Понятна ли threading model?
Есть ли RT violation?
Добавлена ли latency?
Есть ли hidden buffer?
Есть ли тест?
Есть ли diagnostics?
Есть ли failure path?
\`\`\`
**---**
**# 131. PR должен быть маленьким**
Лучше:
\`\`\`text
300 строк понятного изменения
\`\`\`
чем:
\`\`\`text
6000 строк новой архитектуры
\`\`\`
**---**
**# 132. Один PR — одна концептуальная задача**
Не смешивать:
\`\`\`text
ClockSync refactor
\+
new DSP
\+
network change
\+
renaming
\`\`\`
**---**
**# 133. Refactor отдельно от behaviour change**
Если возможно:
\`\`\`text
PR 1:
pure refactor
PR 2:
new behaviour
\`\`\`
Это упрощает review и regression analysis.
**---**
**# 134. Не рефакторить без измеримой причины**
Не:
\`\`\`text
мне кажется так красивее
\`\`\`
А:
\`\`\`text
класс смешивает 3 ответственности
тесты слишком сложны
ownership непонятен
\`\`\`
**---**
**# 135. Метрики размера проекта**
Следить не только за LOC.
Полезнее:
\`\`\`text
files
dependencies
public APIs
state fields
threads
queues
buffers
abstractions
\`\`\`
**---**
**# 136. Complexity budget**
Для каждой feature спрашивать:
\`\`\`text
Сколько новых classes?
Сколько новых threads?
Сколько новых queues?
Сколько новых buffers?
\`\`\`
Если ответ слишком большой — дизайн пересмотреть.
**---**
**# 137. Предпочитать удалить код**
Если новую функцию можно реализовать:
\`\`\`text
+200 lines
\`\`\`
или:
\`\`\`text
remove 80 old lines
+70 new lines
\`\`\`
второй вариант обычно лучше.
**---**
**# 138. Tests тоже имеют complexity budget**
Тестовый код не должен быть в 3 раза сложнее production.
Если один test требует 300 строк setup — architecture/test API плохие.
**---**
**# 139. Test readability важнее deduplication**
Лучше немного повторить:
\`\`\`cpp
RequestedConfiguration config{...};
\`\`\`
чем скрыть всё за 12 helpers и не понимать test.
**---**
**# 140. Test should fail clearly**
Failure должен отвечать:
\`\`\`text
что ожидалось
что получили
\`\`\`
Не просто:
\`\`\`text
test failed
\`\`\`
**---**
**# 141. Performance tests хранят baseline**
Но tolerance не должна быть слишком жёсткой для шумных hardware environments.
**---**
**# 142. Unit tests deterministic**
Никаких sleep-based:
\`\`\`cpp
sleep\_for(100ms);
EXPECT\_TRUE(...)
\`\`\`
Если можно использовать fake clock/event.
**---**
**# 143. Не тестировать concurrency временем**
Использовать synchronization primitives/fakes.
Sleep-based tests флапают.
**---**
**# 144. Race tests повторять**
Concurrency stress может запускать scenario тысячи раз.
**---**
**# 145. Soak tests отдельно**
Не превращать каждый CI run в 8 часов.
**---**
**# 146. Каждый module имеет README только если нужен contract**
Не писать документацию ради документации.
Но сложные boundaries:
\`\`\`text
backend
clock
realtime
\`\`\`
полезно описать коротко.
**---**
**# 147. Документация рядом с кодом**
Contract/interface comment лучше 50-страничной wiki, которая устареет.
**---**
**# 148. Architecture Decision Records для важных решений**
Например:
\`\`\`text
Why render clock is presentation master
Why C++20
Why PCM does not cross IPC
Why bounded queues
\`\`\`
Короткие ADR, не огромные документы.
**---**
**# 149. Любой workaround документировать**
Почему он существует, для какого driver/version, когда можно удалить.
**---**
**# 150. Никаких «временных» костылей без теста**
Временный hack без regression test почти наверняка станет постоянным.
**---**
**# 151. Не допускать параллельных реализаций**
Если переписали component:
\`\`\`text
new component becomes current
old component удаляется
\`\`\`
Не:
\`\`\`text
useNewAudioEngine=true
\`\`\`
навсегда.
**---**
**# 152. Migration должна быть короткой**
Feature flag допустим временно для безопасного перехода.
Но у него должен быть план удаления.
**---**
**# 153. Не делать big rewrite**
После первого core foundation новые изменения — маленькими итерациями.
Большие переписывания чаще всего означают, что система была слишком абстрактной.
**---**
**# 154. Design before code, but briefly**
Перед модулем достаточно определить:
\`\`\`text
Responsibility
Inputs
Outputs
Owner
Thread
Errors
Latency
Tests
\`\`\`
Не писать 50 страниц UML.
**---**
**# 155. Checklist новой сущности**
Перед созданием нового класса спросить:
\`\`\`text
Почему это не функция?
Почему это не часть существующего класса?
Есть ли у него своё состояние?
Есть ли у него свой lifecycle?
Есть ли отдельная ответственность?
\`\`\`
Если нет — новый класс не нужен.
**---**
**# 156. Checklist нового interface**
\`\`\`text
Есть минимум две реальные реализации?
Есть ли необходимая test boundary?
Скрывает ли он внешнюю платформу?
\`\`\`
Если нет — interface скорее всего лишний.
**---**
**# 157. Checklist новой queue**
\`\`\`text
Кто producer?
Кто consumer?
Capacity?
Overflow policy?
Latency?
Diagnostics?
\`\`\`
Если ответа нет — queue запрещена.
**---**
**# 158. Checklist нового thread**
\`\`\`text
Почему нельзя существующий?
Что делает?
Как останавливается?
Какой priority?
Как коммуницирует?
Что если зависнет?
\`\`\`
**---**
**# 159. Checklist нового buffer**
\`\`\`text
Зачем?
Frames?
Owner?
Lifetime?
Latency?
Can it overflow?
Can it underflow?
\`\`\`
**---**
**# 160. Checklist нового DSP**
\`\`\`text
Latency?
CPU?
Block-size requirements?
State?
Reset semantics?
Bypass semantics?
Failure behaviour?
\`\`\`
**---**
**# 161. Checklist новой feature**
Feature не готова без:
\`\`\`text
implementation
tests
diagnostics
failure behaviour
latency impact
CPU impact
ownership
threading
\`\`\`
**---**
**# 162. Главная структура проекта**
Держать по domain:
\`\`\`text
src/
├── app/
├── session/
├── backend/
│   ├── fake/
│   ├── wasapi/
│   └── asio/
├── devices/
├── realtime/
├── clock/
├── graph/
├── dsp/
├── recording/
├── analysis/
├── network/
├── diagnostics/
└── ipc/
\`\`\`
**---**
**# 163. Tests зеркалят structure**
\`\`\`text
tests/
├── session/
├── backend/
├── devices/
├── realtime/
├── clock/
├── graph/
├── dsp/
├── recording/
├── analysis/
├── network/
└── integration/
\`\`\`
**---**
**# 164. Не создавать папки \`managers\`, \`services\`, \`helpers\`**
Такие папки скрывают domain.
**---**
**# 165. Один canonical implementation**
Всегда:
\`\`\`text
Mixer
\`\`\`
Не:
\`\`\`text
Mixer
MixerNew
Mixer2
MixerExperimental
\`\`\`
**---**
**# 166. Git хранит историю**
Поэтому старый код можно удалять уверенно.
**---**
**# 167. Definition of Done**
Любая задача считается законченной только если:
\`\`\`text
код минимальный
нет лишней abstraction
ownership понятен
threading понятен
нет duplicate state
нет hidden allocation
нет hidden buffer
тесты чистые
diagnostics есть
latency измерена
failure path определён
нет TODO без issue
старый код удалён
\`\`\`
**---**
**# 168. Главный стиль кода**
Код должен читаться примерно так:
\`\`\`cpp
auto runtime = backend.open(request);
auto plan = buildSessionPlan(request, runtime);
buffers.prepare(plan);
clocks.prepare(plan);
graph.prepare(plan);
backend.start();
\`\`\`
А не:
\`\`\`cpp
AudioPipelineManagerFactory::instance()
    .resolve(...)
    .configure(...)
    .dispatch(...)
\`\`\`
**---**
**# 169. Главный стиль realtime-кода**
\`\`\`cpp
capture();
convert();
process();
mix();
render();
\`\`\`
Максимально линейно.
**---**
**# 170. Главный стиль тестов**
\`\`\`cpp
TEST(AudioSession, UsesRuntimePeriodReturnedByBackend) {
    FakeAudioBackend backend;
    backend.runtimePeriodFrames = 144;
    AudioSession session{backend};
    session.prepare(requestWithPeriod(128));
    EXPECT\_EQ(session.runtime().periodFrames, 144);
}
\`\`\`
То есть тест читается без знания внутренней магии проекта.
**---**
**# 171. Главное правило против разрастания**
Перед каждым добавлением кода спросить:
\`\`\`text
Можно ли решить задачу без нового класса?
Можно ли решить без нового thread?
Можно ли решить без новой queue?
Можно ли решить без нового state?
Можно ли удалить что-то существующее?
\`\`\`
**---**
**# 172. Главное правило против переписываний**
Не пытаться сразу предугадать всё будущее.
Вместо этого сделать:
\`\`\`text
простое правильное ядро
\+
жёсткие contracts
\+
тесты
\+
observability
\`\`\`
Тогда новые возможности добавляются без переписывания ядра.
**---**
**# 173. Что действительно нужно спроектировать правильно сразу**
Вот это менять потом дорого, поэтому зафиксировать хорошо с первого раза:
\`\`\`text
ownership
threading model
realtime contract
state machine
generationId
Requested vs Runtime
frames/timestamps model
backend boundary
bounded queues
diagnostics model
error model
\`\`\`
**---**
**# 174. Что НЕ нужно переусложнять заранее**
\`\`\`text
DSP graph framework
plugin architecture
generic routing engine
universal dependency injection
custom allocator everywhere
template frameworks
abstract factories
multi-platform abstraction
\`\`\`
пока это реально не требуется.
**---**
**# 175. Эталонный принцип**
Архитектура считается хорошей, если разработчик может открыть любой module и быстро понять:
\`\`\`text
что он делает
кто им владеет
на каком thread работает
откуда получает данные
куда отдаёт данные
сколько latency добавляет
как ломается
как тестируется
\`\`\`
Если для понимания одного класса нужно открыть 15 других файлов — архитектура уже слишком сложная.
**---**
**# 176. Финальное правило**
\`\`\`text
MINIMUM CODE
\+
CLEAR OWNERSHIP
\+
CLEAR THREADING
\+
SMALL PUBLIC APIs
\+
BOUNDED STATE
\+
BOUNDED MEMORY
\+
BOUNDED QUEUES
\+
EXPLICIT LATENCY
\+
EXPLICIT FAILURES
\+
READABLE TESTS
\+
NO DUPLICATE IMPLEMENTATIONS
\`\`\`
Это и должно быть главным стандартом проекта.
**---**
**# 177. Самое важное правило команды**
Перед merge каждый новый код должен доказать:
\`\`\`text
он действительно нужен
его нельзя сделать проще
он не дублирует существующий код
он не создаёт скрытую latency
он не создаёт новый непонятный lifecycle
он не создаёт новый race
он покрыт понятным тестом
его можно удалить/изменить без разрушения половины проекта
\`\`\`
Если хотя бы на один пункт ответ сомнительный — код стоит упростить до merge.

**# Простота кода и устранение повторов**
**## Универсальное правило устранения повторов во всех файлах**
Это одна часть общего набора правил из [AGENTS.md]\(../AGENTS.md); она не заменяет план, архитектуру, качество, правила замены реализации или этапы. Примеры ниже показывают способы решения, но не перечисляют все возможные нарушения. Самостоятельно ищи и исправляй любые места, где форма кода сложнее его смысла.
Обязательный порядок проверки **\*\*всех\*\*** правил задан в [AGENTS.md]\(../AGENTS.md#блокер-завершения-изменения). Проверка повторов ниже — один из пунктов этого общего порядка, а не отдельный необязательный ритуал. После любого изменения возвращайся ко всему перечню правил проекта; нельзя считать соблюдение одного правила доказательством соблюдения остальных.
Перед завершением любого изменения проверь весь проект: production code, заголовки, тесты, IPC, сборку и документацию. Не ограничивай правило файлом или примером, из-за которого оно появилось. Найди повторяющиеся значения, вызовы, типы, выражения, ветки и последовательности действий; выбери самый простой подходящий способ:
\- Одна константа повторяется в строках таблицы — задай её один раз в структуре сценария или в общем цикле; исключения запиши явно в данных.
\- Повторяется один длинный тип в объявлениях и сигнатурах — используй **\*\*понятный смысловой alias\*\*** в минимальной подходящей области. Разные единицы и назначения не смешивай ради сокращения текста. Не вводи непонятные сокращения вроде \`sv\` или \`U32\`.
\- Тип повторяется только потому, что элементы одного массива объявлены по отдельности — укажи тип один раз в \`std::array<Тип, N>\` или позволь вывести его, если это читается проще.
\- Одна операция повторяется с разными данными — используй таблицу и цикл. Повторяется последовательность технических действий — небольшой helper. Повторяется только сопоставление значений — lookup. Разное поведение — явная ветка.
\- Не создавай alias, helper или таблицу, если результат сложнее, скрывает смысл или не устраняет реальный повтор.
После правки повторно найди старую форму по всему проекту и проверь объявления, определения, вызовы, тесты и сборку. Проверка соответствия этому правилу — обязательный блокер перед объявлением задачи завершённой.
**## Обязательный обзор повторов перед завершением**
Проверяй каждый изменённый файл **\*\*от начала до конца\*\***, затем остальные файлы на тот же класс проблемы. Для каждого файла проходи этот список, включая тесты и заголовки:
1\. Повторяются ли квалифицированные имена enum, класса, namespace или длинные типы (\`ControlCommand::\`, \`SessionState::\`, \`std::uint32\_t\` и другие)? Если локальный понятный alias делает код яснее, введи его в минимальной области. Сначала различи случаи, где полное имя необходимо для ясности или предотвращения смешения типов.
2\. Повторяются ли литералы, константы, поля или аргументы в таблице и вызовах? Вынеси общее значение на уровень сценария или цикла; исключения оставь явно в данных.
3\. Повторяются ли в тестах \`expect\`, \`expected\`, сравнения, сообщения об ошибках или техническое построение условий? Для одинаковой проверки с разными данными примени таблицу и цикл; для повторяющегося технического сценария — небольшой смысловой helper. Если повторяется сценарий \`действие → expected result → expected state/ошибка/счётчик\`, запиши **\*\*все последовательные шаги и их ожидания\*\*** в таблицу и выполняй её по порядку. Не ограничивайся таблицей только для проверок после действий, оставляя сами повторяющиеся \`expect\` сценария вразнобой. Проверь **\*\*все\*\*** тестовые файлы, а не только уже переработанные участки.
4\. Повторяются ли условия, mapping, обработка ошибок или блоки действий в разных функциях? Сравни их смысл, затем выбери таблицу, общий helper либо явное ветвление.
5\. Не остались ли после упрощения старые пути, лишние includes, временные aliases, избыточные параметры или дубли ответственности?
Поиск по частым именам и вызовам используй как подсказку, а решение принимай после чтения контекста. После изменения повтори поиск исходной формы и проверь соседние файлы с той же ответственностью. Для сценария с изменением состояния таблица допустима, если её порядок явно задаёт порядок действий и каждый шаг содержит собственное ожидаемое поведение и понятное сообщение о сбое. Не скрывай разные требования за одним безымянным \`expected\`. Если повтор сохранён осознанно, должна быть конкретная причина, почему явная запись понятнее.
**### Проверка, предотвращающая пропуск сценария в тестах**
После первого упрощения сделай **\*\*второй проход\*\***, не опираясь на то, какие строки уже изменены:
1\. Перечитай все тестовые файлы. Для каждой цепочки проверок выдели целый сценарий: \`подготовка → действие → expected result → expected state/ошибка/счётчик\`.
2\. Сравни сценарии между тестами. Если порядок действий важен, сохрани его порядком строк в таблице и выполняй таблицу последовательно. Чередование разных методов и переходы состояния сами по себе не оправдывают повторяющиеся прямые \`expect\`.
3\. Проверь, что таблица охватывает **\*\*действия и все связанные ожидания\*\***, а не только несколько одинаковых сравнений в конце сценария. Общий helper должен исполнять шаг и проверять его результат; ожидаемые значения и сообщение о сбое принадлежат строке таблицы.
4\. Повторно просмотри оставшиеся прямые \`expect\`. Оставляй их, когда сценарии действительно различаются или таблица скрыла бы смысл; принимай решение по каждому оставшемуся блоку, а не по всему файлу сразу.
Этот проход обязателен перед объявлением работы завершённой. Прохождение тестов подтверждает поведение, но не заменяет проверку повторов.
\- Если ветки отличаются только данными — используй table/lookup вместо \`switch\` или длинного \`if/else\`.
\`\`\`cpp
constexpr std::array names{
    "Starting",
    "Running",
    "Stopping",
    "Stopped",
    "Failed"
};
return names[static\_cast\<std::size\_t>(state)];
\`\`\`
\- Для плотного контролируемого enum предпочитай \`constexpr std::array\`.
\- Не используй \`std::map\`, \`std::unordered\_map\`, \`std::function\`, polymorphism или command objects, если простой массив или \`switch\` короче.
\- Если enum используется как индекс массива, добавляй \`Count\` и проверяй размер:
\`\`\`cpp
enum class ServiceState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
    Count
};
static\_assert(
    names.size() ==
    static\_cast\<std::size\_t>(ServiceState::Count)
);
\`\`\`
\- Если значение enum может прийти извне, проверяй индекс перед доступом к массиву.
\- Для неизменяемых строк предпочитай \`std::string\_view\`.
\- Если ветки выполняют реально разную работу **\*\*и различается логика ветвления вокруг неё\*\***, оставляй \`switch\`. Разные имена вызываемых функций сами по себе не доказывают необходимость \`switch\`: когда ветки только выбирают совместимую операцию, общий вызов может идти через таблицу.
\`\`\`cpp
switch (state) {
case ServiceState::Starting:
    beginStartup();
    break;
case ServiceState::Running:
    processAudio();
    break;
case ServiceState::Stopping:
    stopAudio();
    break;
}
\`\`\`
\- Не дублируй одинаковый \`switch\` для одного enum в разных местах. Общие mapping/metadata выноси в одно место.
\- Если несколько значений имеют одинаковое поведение — объединяй их, не копируй код.
\- Для проверки принадлежности фиксированному набору не используй длинные \`||\`.
C++20:
\`\`\`cpp
constexpr std::array states{A, B, C};
if (std::ranges::find(states, state) != states.end()) {
    // ...
}
\`\`\`
C++23:
\`\`\`cpp
if (std::ranges::contains(std::array{A, B, C}, state)) {
    // ...
}
\`\`\`
\- Если один enum в разных местах сопоставляется с \`name\`, \`color\`, \`severity\`, flags и т.д. — используй единую metadata-таблицу.
\`\`\`cpp
struct StateInfo {
    std::string\_view name;
    bool active;
    bool terminal;
};
constexpr std::array stateInfo{
    StateInfo{"Starting", true, false},
    StateInfo{"Running", true, false},
    StateInfo{"Stopping", true, false},
    StateInfo{"Stopped", false, true},
    StateInfo{"Failed", false, true}
};
\`\`\`
**## Главное правило**
\`\`\`text
РАЗНЫЕ ДАННЫЕ
→ TABLE / LOOKUP
ВЫБОР ОПЕРАЦИИ С ЕДИНЫМ КОНТРАКТОМ И ОБЩИМ ВЫЗОВОМ
→ TABLE / LOOKUP + ОДИН ВЫЗОВ
РАЗНОЕ ПОВЕДЕНИЕ
→ SWITCH
ПРОВЕРКА НАБОРА ЗНАЧЕНИЙ
→ ranges::contains / ranges::find
\`\`\`
**## Правило для агента**
Перед созданием \`switch\` или длинного \`if/else\` проверь:
1\. Ветки выбирают данные, совместимую операцию или содержат собственную логику? Разные функции с одинаковой сигнатурой и одинаковой обработкой результата считаются выбором операции.
2\. Можно ли заменить на \`constexpr std::array\` значений, указателей на функции/методы либо non-capturing lambdas и один общий вызов?
3\. Это просто проверка принадлежности набору?
4\. Не существует ли уже общей metadata-таблицы?
5\. Не дублируется ли эта логика в другом месте?
6\. Не станет ли замена сложнее исходного кода?
Если решение с таблицей короче и понятнее — используй таблицу.
Если \`switch\` понятнее — оставляй \`switch\`.
Это правило относится к \`switch\`, \`if/else\`, выбору обработчика и сериям одинаковых присваиваний или возвратов результата во **\*\*всех\*\*** исходниках и тестах. Для плотного внутреннего enum свяжи таблицу с \`Count\` через \`static\_assert\`; внешний индекс проверь перед обращением. В последовательных тестах храни операцию в строке шага рядом с его ожиданиями, если это убирает отдельное сопоставление. Оставляй явные ветки, когда различаются проверки, управление потоком, побочные эффекты вокруг вызова, сигнатуры либо требования к результату. Перед завершением изменения просмотри каждый затронутый файл целиком на этот смысловой шаблон: поиск \`switch\` и \`if/else\` служит подсказкой, но не заменяет чтение кода.
**## Повторяющиеся вызовы с разными данными**
\- Если несколько строк вызывают одну и ту же функцию, а отличаются только передаваемыми значениями, не дублируй вызовы.
\- Вынеси изменяющиеся значения в \`constexpr\` таблицу и обработай её циклом.
\- Для двух связанных значений используй \`std::pair\`; для большего числа — небольшую \`struct\`.
\- Не используй \`std::map\` или \`std::unordered\_map\`, если поиск по ключу не нужен.
Плохо:
\`\`\`cpp
expectContains(dump, "SessionState: Idle", "session must be Idle");
expectContains(dump, "Input: Closed", "input must be Closed");
expectContains(dump, "Output: Closed", "output must be Closed");
\`\`\`
Лучше:
\`\`\`cpp
constexpr std::pair checks[]{
    {"SessionState: Idle", "session must be Idle"},
    {"Input: Closed", "input must be Closed"},
    {"Output: Closed", "output must be Closed"},
};
for (const auto &[value, message] : checks) {
    expectContains(dump, value, message);
}
\`\`\`
Главное правило: \`одинаковая операция + меняются только данные → table + loop\`.
Перед заменой повторяющихся вызовов проверь, выполняют ли они одну и ту же логику и останется ли код с циклом понятнее. Если логика различается, оставь отдельные вызовы.
**## Общее значение в табличных сценариях**
\- Если одно поле одинаково почти во всех строках таблицы, не повторяй его в каждой строке. Задай значение один раз в структуре сценария или при выполнении общего цикла.
\- В строках оставь только различающиеся данные. Редкое отклонение укажи явно в соответствующей строке.
\- Не вводи для этого сложную фабрику, дополнительную иерархию или неявное состояние. Сохранение общего значения и исключения должно читаться прямо из кода.
\- Перед применением проверь все похожие таблицы в проекте, в том числе тестовые сценарии.
Пример для C++20:
\`\`\`cpp
struct RequestCheck {
    ControlCommand command;
    ControlStatus expectedStatus;
    std::uint32\_t protocolVersion = ControlProtocolVersion;
};
constexpr RequestCheck checks[]{
    {ControlCommand::GetServiceState, ControlStatus::Ok},
    {.command = ControlCommand::GetServiceState,
     .expectedStatus = ControlStatus::ProtocolVersionMismatch,
     .protocolVersion = ControlProtocolVersion + 1},
};
for (const auto &check : checks) {
    expectRequest({check.protocolVersion, check.command}, check.expectedStatus);
}
\`\`\`
Главное правило: \`одно значение для большинства строк → задать один раз; исключения → явно в данных\`.
**## Однородные проверки внутри составного условия**
Если несколько полей проверяются одинаково, например на ноль, собери **\*\*только эти поля\*\*** в \`std::array\` и выполни одну проверку. Остальные условия с другим смыслом оставь явными. Не создавай таблицу пар и дополнительные булевы переменные ради двух простых сравнений.
\`\`\`cpp
const std::array values{
    runtime.inputSampleRateHz,
    runtime.outputSampleRateHz,
    runtime.inputPeriodFrames,
    runtime.outputPeriodFrames,
    runtime.maxCapturePacketFrames,
    runtime.inputChannels,
    runtime.outputChannels,
};
if (std::ranges::find(values, 0u) != values.end() ||
    runtime.inputEndpointBufferFrames < runtime.inputPeriodFrames ||
    runtime.outputEndpointBufferFrames < runtime.outputPeriodFrames ||
    std::ranges::any\_of(settings\_.capturePacketFrames, [&]\(std::uint32\_t frames) {
        return frames == 0 || frames > runtime.maxCapturePacketFrames;
    })) {
    // Invalid runtime configuration.
}
\`\`\`
Главное правило: \`одинаковая проверка многих значений → таблица; два понятных сравнения с разным смыслом → оставить явными\`.
**## Цепочки \`if/else\`, которые только сопоставляют значения**
\- Если \`if / else if\` только сопоставляет одно значение другому и не содержит дополнительной логики, заменяй цепочку на таблицу соответствий.
\- Для маленького фиксированного набора используй \`constexpr std::pair[]\` и поиск по таблице.
\- Не используй \`std::map\` или \`std::unordered\_map\`, если набор маленький и статический.
Плохо:
\`\`\`cpp
if (commandName == "state") {
    command = ControlCommand::GetServiceState;
} else if (commandName == "audio-dump") {
    command = ControlCommand::GetDiagnostics;
} else if (commandName == "shutdown") {
    command = ControlCommand::ShutdownService;
}
\`\`\`
Лучше:
\`\`\`cpp
constexpr std::pair\<std::string\_view, ControlCommand> commands[]{
    {"state", ControlCommand::GetServiceState},
    {"audio-dump", ControlCommand::GetDiagnostics},
    {"shutdown", ControlCommand::ShutdownService},
};
const auto it = std::ranges::find\_if(commands, [&]\(const auto &entry) {
    return entry.first == commandName;
});
if (it == std::end(commands)) {
    // Unknown command.
}
const auto command = it->second;
\`\`\`
Главное правило: \`одно значение → просто сопоставляется с другим → table / lookup\`.
Перед заменой проверь, что цепочка сравнивает одно и то же значение, каждая ветка лишь выбирает константу/enum/строку/число и не выполняет разную бизнес-логику. Если работа веток различается, оставь \`if/else\` или \`switch\`.
**## Повторяющийся сценарий вызовов**
\- Если в нескольких местах повторяется одна и та же последовательность действий, а меняются только входные данные и ожидаемый результат, вынеси последовательность в небольшой helper.
\- Helper скрывает технический шаблон, не бизнес-логику. Не создавай его ради одного вызова или если множество параметров делает код сложнее.
\- Если повторяется только набор данных одной операции, используй \`table + loop\`; если повторяется последовательность действий, используй helper.
Пример:
\`\`\`cpp
void expectRequest(const std::wstring &pipeName, ControlRequest request,
                   ControlStatus expectedStatus, const char \*message,
                   ControlResponse &response) {
    expect(sendControlRequest(pipeName, request, response) &&
               response.status == expectedStatus,
           message);
}
\`\`\`
Использование:
\`\`\`cpp
expectRequest(pipeName,
              {ControlProtocolVersion, ControlCommand::GetServiceState},
              ControlStatus::Ok,
              "state request must succeed",
              response);
\`\`\`
Для проверки наличия текста в C++20 используй:
\`\`\`cpp
text.find(value) != std::string\_view::npos
\`\`\`
Главное правило:
\`\`\`text
ОДИНАКОВЫЕ ДЕЙСТВИЯ + РАЗНЫЕ АРГУМЕНТЫ → HELPER
ОДИНАКОВАЯ ОПЕРАЦИЯ + МНОГО НАБОРОВ ДАННЫХ → TABLE + LOOP
\`\`\`
Перед созданием helper найди повторяющуюся последовательность, передавай только меняющиеся значения и проверь, что итоговый тест читается проще исходного.
**## Повторяющиеся технические выражения**
\- Если в вызывающем коде часто повторяется технический тип или шаблон выражения, предпочитай маленький смысловой helper, который скрывает детали.
\- Называй helper по смыслу операции, а не по используемому типу. \`std::string\_view\`, \`find\`, \`npos\`, cast и сравнения держи внутри helper, если вызывающему коду они не нужны.
\- Не вводи короткий alias вроде \`sv\` лишь для экономии символов. Alias допустим, когда сам тип действительно используется много раз напрямую и helper не подходит.
\- Не выноси одноразовое выражение, если helper не улучшает читаемость.
Для таблицы указателей на поля, где имя одного класса повторяется много раз, используй локальный смысловой alias и позволь \`std::array\` вывести тип элементов:
\`\`\`cpp
using Runtime = RuntimeConfiguration;
constexpr std::array requiredFields{
    &Runtime::inputSampleRateHz,
    &Runtime::outputSampleRateHz,
    &Runtime::inputPeriodFrames,
};
\`\`\`
Не добавляй отдельный alias типа поля, если вывод типа массива уже делает его ненужным.
Пример для C++20:
\`\`\`cpp
void expectText(const char \*text, std::string\_view expected, const char \*message) {
    expect(std::string\_view{text} == expected, message);
}
void expectContains(const char \*text, std::string\_view expected, const char \*message) {
    expect(std::string\_view{text}.find(expected) != std::string\_view::npos,
           message);
}
expectText(response.text, "Running", "service state must be Running");
expectContains(response.text, "SessionState: Idle",
               "diagnostics must report Idle session");
\`\`\`
Главное правило:
\`\`\`text
ПОВТОРЯЕТСЯ ТЕХНИЧЕСКОЕ ВЫРАЖЕНИЕ → СМЫСЛОВОЙ HELPER
ПОВТОРЯЕТСЯ ТОЛЬКО ДЛИННОЕ ИМЯ ТИПА → TYPE ALIAS, ЕСЛИ ОН УПРОЩАЕТ КОД
ТЕХНИЧЕСКАЯ ДЕТАЛЬ НЕ НУЖНА ВЫЗЫВАЮЩЕМУ КОДУ → СПРЯТАТЬ В HELPER
\`\`\`
Перед добавлением helper определи смысл проверки, передавай только нужные данные и убедись, что результат читается легче исходного выражения.