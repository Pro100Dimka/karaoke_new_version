# Python Backend — эталонные правила архитектуры и кода

**Status:** `LOCKED`

## 1. Цель

Python Backend должен оставаться:

```text
простым
маленьким
явным
предсказуемым
типизированным
тестируемым
восстанавливаемым
измеримым
```

даже после нескольких лет развития проекта.

Главное правило:

```text
Рост количества функций продукта
не должен приводить
к росту одного огромного модуля.
```

Backend должен расти новыми независимыми capabilities, а не одним всё более сложным service.

---

# 2. Domain-first architecture

Структура проекта строится по предметным областям:

```text
backend/
├── api/
├── songs/
├── projects/
├── processing/
├── ai/
├── lyrics/
├── editor/
├── packages/
├── recordings/
├── analysis/
├── models/
├── storage/
├── settings/
├── history/
├── room/
├── recovery/
├── diagnostics/
├── capabilities/
├── bootstrap/
└── infrastructure/
```

Не использовать как основную структуру:

```text
services/
repositories/
models/
helpers/
utils/
```

с сотнями несвязанных файлов внутри.

---

# 3. Один модуль — одна предметная ответственность

Хорошо:

```text
ProcessingJobManager
→ lifecycle jobs

PipelineOrchestrator
→ orchestration stages

ProjectPublisher
→ publication

PackageImporter
→ package import

RecordingRegistry
→ recording metadata
```

Плохо:

```text
SongService
→ import
→ processing
→ editor
→ packages
→ recordings
→ storage
→ cache
→ history
```

---

# 4. God Service запрещён

Нельзя создавать:

```text
BackendService
ApplicationManager
SystemManager
EverythingRepository
CoreService
GlobalService
```

если объект знает о большом количестве независимых domains.

Если объекту требуется 10–15 unrelated dependencies, это почти всегда признак неправильной ответственности.

---

# 5. Размер production-файла

Ориентиры:

```text
50–250 строк
→ нормально

250–350
→ проверить ответственность

350–500
→ требуется явная причина

>500
→ по умолчанию архитектурная проблема
```

Исключения:

```text
generated code
large static schemas/data
migrations with unavoidable declarations
```

---

# 6. Не дробить искусственно

Не превращать:

```text
один понятный cohesive module
```

в:

```text
20 файлов по 15 строк
```

ради line limit.

Разделение выполняется по ответственности.

---

# 7. Размер функций

Обычная функция:

```text
5–40 строк
```

Если функция значительно больше:

```text
проверить:
- смешаны ли уровни abstraction;
- есть ли orchestration + implementation;
- есть ли несколько side effects;
- можно ли выделить понятные этапы.
```

---

# 8. Один уровень abstraction

Плохо:

```python
def process_song():
    # SQL
    # filesystem
    # PyTorch
    # JSON
    # HTTP
    # DB commit
```

Хорошо:

```python
def process_song():
    source = source_loader.load(...)
    result = pipeline.run(source)
    publisher.publish(result)
```

---

# 9. Dependency direction

Основное направление:

```text
API
↓
Application
↓
Domain
↓
Ports
↑
Infrastructure
```

Domain не импортирует:

```text
FastAPI
SQLAlchemy
PyTorch implementation
filesystem implementation
HTTP provider implementation
```

---

# 10. API layer всегда тонкий

Router делает:

```text
validate request
↓
call use-case
↓
map result
↓
return response
```

Router не делает:

```text
SQL query
filesystem operation
AI inference
transaction coordination
business decision
```

---

# 11. Use-case вместо общего Service

Предпочитать:

```text
ImportSong
DeleteSong
StartProcessing
CancelProcessing
SaveEditorDocument
ExportPackage
RegisterRecording
```

вместо:

```text
SongService
PackageService
AppService
```

---

# 12. Один use-case — одна бизнес-операция

Use-case не должен отвечать за десяток независимых действий.

---

# 13. Domain Model ≠ API DTO ≠ ORM Model

Разделяются:

```text
API DTO
Domain Model
Persistence Model
```

Нельзя протаскивать SQLAlchemy entity через весь backend.

---

# 14. Repository — только persistence

Repository отвечает за:

```text
load
save
query
delete
```

Не делает:

```text
AI
packages
HTTP
processing
business orchestration
```

---

# 15. Repository по aggregate

Предпочитать:

```text
SongRepository
RecordingRepository
```

а не repository на каждую мелкую таблицу без причины.

---

# 16. Infrastructure через ports

External implementation находится в:

```text
infrastructure/
```

Например:

```text
SqlAlchemySongRepository
LocalProjectStorage
HttpLyricsProvider
TorchPitchEngine
FfmpegRunner
```

Application/domain зависит от contracts, а не implementations.

---

# 17. Interface только когда нужен

Создавать interface/protocol если есть:

```text
несколько implementations
external boundary
runtime provider choice
важная test boundary
```

Не создавать интерфейс механически для каждого класса.

---

# 18. Не создавать abstraction на будущее

Запрещено без реального use-case:

```text
UniversalProcessor
GenericManagerFactory
AbstractEntityService
PluginEverythingRegistry
```

Сначала простая concrete implementation.

---

# 19. Composition вместо inheritance

Предпочитать:

```python
PipelineOrchestrator(
    separator=...,
    aligner=...,
    pitch_engine=...,
    publisher=...,
)
```

вместо глубокой иерархии классов.

---

# 20. Наследование только для настоящего subtype polymorphism

Не использовать inheritance просто ради reuse нескольких методов.

---

# 21. Mutable globals запрещены

Нельзя:

```python
active_jobs = {}
global_config = {}
current_models = {}
```

как изменяемое global state без owner.

---

# 22. У каждого state один owner

Например:

```text
ProcessingJobManager
→ jobs

ModelRegistry
→ models

StorageConfiguration
→ storage roots
```

---

# 23. Один Source of Truth

Для каждого понятия один authoritative owner.

Например:

```text
Song metadata
→ Song aggregate

Project content
→ Project revision

Job state
→ JobManager

Model state
→ ModelRegistry
```

---

# 24. Derived state не хранить без причины

Если значение можно безопасно вычислить — вычислять.

Если derived state кэшируется, invalidation должна быть explicit.

---

# 25. Config immutable внутри операции

Use-case/job получает configuration snapshot.

Нельзя, чтобы операция в середине execution внезапно увидела другой mutable global config.

---

# 26. Settings меняются через отдельный use-case

Не:

```python
config.MODEL_ROOT = new_path
```

из случайного места.

А:

```text
UpdateModelStorage
↓
validate
↓
commit
↓
new configuration snapshot
```

---

# 27. Configuration Schema versioned

Persistent config имеет:

```text
settingsSchemaVersion
```

и migrations.

---

# 28. Configuration валидируется при startup

Невалидный configuration должен обнаруживаться сразу, а не во время тяжёлой операции спустя час.

---

# 29. Feature-specific settings рядом с feature

Не создавать один огромный:

```text
AppSettings
```

на сотни несвязанных полей.

Например:

```text
ProcessingSettings
StorageSettings
ModelSettings
RoomSettings
```

---

# 30. Dict не является domain model

Плохо:

```python
payload["song"]["revision"]["id"]
```

Правильно:

```python
SongRevision(...)
```

---

# 31. Pydantic — на boundaries

Использовать для:

```text
API DTO
configuration
external payload validation
provider response validation
```

---

# 32. Internal domain может быть dataclass/value object

Например:

```python
@dataclass(frozen=True)
class SongRevision:
    ...
```

---

# 33. `Any` минимален

`Any` допускается на raw boundary и должен быстро преобразовываться в typed structure.

---

# 34. Enum вместо string state

Использовать:

```python
ProcessingState.RUNNING
```

а не случайные `"running"` по всему проекту.

---

# 35. Boolean soup запрещён

Плохо:

```text
is_running
is_failed
is_cancelled
is_ready
```

для одного lifecycle.

Правильно:

```text
state: JobState
```

---

# 36. State transition централизован

Не менять state случайно в разных modules.

Transition должен быть валиден:

```text
Queued
→ Running
→ Succeeded
```

а invalid transition должен отклоняться.

---

# 37. Много boolean arguments запрещено

Не:

```python
process(fast=True, force=False, gpu=True, cache=True, ...)
```

А:

```python
ProcessingOptions(...)
```

---

# 38. Guard clauses вместо вложенности

Предпочитать:

```python
if song is None:
    raise SongNotFound()

if not song.can_process:
    raise InvalidSongState()
```

---

# 39. Не использовать broad `except`

Запрещено:

```python
except Exception:
    pass
```

без очень конкретной причины.

---

# 40. Ловить только ошибки, с которыми можно что-то сделать

Не писать:

```python
try:
    ...
except SomeError:
    raise
```

без добавления смысла/context.

---

# 41. Infrastructure errors переводятся на границе

Например:

```text
OSError
↓
StorageError
```

```text
SQLAlchemyError
↓
RepositoryError
```

---

# 42. Domain errors стабильны

Например:

```text
SongNotFound
RevisionConflict
ProjectInvalid
MissingRequiredModel
StorageUnavailable
```

---

# 43. Exception не используется как обычный branch

Обычные lifecycle states лучше представлять явным типом/result.

---

# 44. Silent fallback запрещён

Если произошло:

```text
CUDA → CPU
ProviderA → ProviderB
```

это должно быть:

```text
policy-driven
observable
diagnosable
```

---

# 45. Transactions explicit

Если use-case изменяет:

```text
DB
+
filesystem
```

transaction/recovery boundary определяется заранее.

---

# 46. Не размазывать DB commit

Transaction контролирует application use-case или Unit of Work.

Repository не должен неожиданно commit-ить каждое действие.

---

# 47. DB transaction должна быть короткой

Нельзя держать открытую DB transaction во время:

```text
AI inference
FFmpeg
HTTP request
model download
large file operation
```

Сначала тяжёлая работа, затем короткая publication transaction.

---

# 48. DB Session lifetime ограничен

Обычная SQLAlchemy Session живёт:

```text
request/use-case
```

а не:

```text
Application lifetime
Manager lifetime
global lifetime
```

---

# 49. Background Job получает собственный DB context

Нельзя передавать request-scoped Session в:

```text
thread
worker
background task
```

Job открывает свой Unit of Work/Session.

---

# 50. ORM lazy loading не выходит из persistence boundary

Не допускать неожиданных SQL query где угодно в application code.

Нужные данные загружаются явно.

---

# 51. N+1 query запрещён

List endpoint не должен выполнять:

```text
1 query songs
+
N queries metadata
+
N queries recordings
```

Projection/eager loading/query design определяется заранее.

---

# 52. Projection минимальный

Для Library list не загружать огромные domain objects, если UI нужны:

```text
songId
title
artist
status
cover state
```

---

# 53. Large BLOB не хранить в SQLite

В SQLite:

```text
metadata
references
state
```

На filesystem:

```text
audio
models
archives
large artifacts
recordings
```

---

# 54. Atomic publication

Новые persistent artifacts:

```text
write temporary
↓
validate
↓
atomic publish
```

---

# 55. Published revision immutable

Опубликованная ProjectRevision рассматривается как snapshot.

Новая mutation создаёт новую revision.

---

# 56. Optimistic concurrency

Editor/project mutation использует:

```text
expectedRevision
```

---

# 57. Silent last-write-wins запрещён

При конфликте:

```text
RevisionConflict
```

---

# 58. Lock минимального scope

Предпочитать:

```text
per-song
```

а не один global lock.

---

# 59. Не держать lock во время AI

AI processing выполняется без длительного content lock.

Lock нужен в critical publication phase.

---

# 60. Lock ordering фиксирован

Если нужны несколько locks, их порядок всегда один.

---

# 61. Recovery проектируется до implementation

Перед multi-step persistent use-case ответить:

```text
Что будет при crash после шага 1?
После шага 2?
После шага 3?
```

---

# 62. Recovery является частью use-case

Не добавлять recovery «потом».

---

# 63. Persistent formats versioned

Минимум:

```text
DB schema
Settings schema
Project format
Package format
Analysis result version
```

---

# 64. Migration tests обязательны

Для каждого supported old format:

```text
old
→ migrate
→ current
→ validate
```

---

# 65. Migration destructive только осознанно

Перед destructive migration:

```text
backup/snapshot
```

или explicit documented irreversible policy.

---

# 66. Old compatibility code не живёт вечно

После migration window legacy path удаляется.

---

# 67. Замена реализации удаляет старую

Когда новая implementation полностью заменяет предыдущую:

```text
switch call sites
↓
tests
↓
delete old code
↓
delete old tests
↓
delete flags
↓
delete dependencies
```

---

# 68. V2/V3/Final запрещены

Не создавать:

```text
SongServiceV2
NewPipeline
FinalPipeline
Manager2
```

---

# 69. Git хранит историю

Не хранить старый code «на всякий случай».

---

# 70. Background execution централизован

Не запускать случайные:

```python
threading.Thread(...)
asyncio.create_task(...)
```

по всему проекту.

---

# 71. Job infrastructure единая

Обеспечивает:

```text
start
state
progress
cancel
error
recovery
```

---

# 72. Domain logic jobs отдельная

JobManager не знает деталей AI/package/analysis.

---

# 73. No fire-and-forget

Каждая task/thread имеет:

```text
owner
lifecycle
shutdown
error handling
```

---

# 74. Bounded concurrency

Всегда ограничены:

```text
threads
processes
queues
parallel jobs
```

---

# 75. Queue всегда bounded

Определить:

```text
capacity
overflow behavior
```

---

# 76. Retry bounded

У retry есть:

```text
max attempts
delay/backoff
terminal failure
```

---

# 77. Timeout обязателен для external dependency

Например:

```text
HTTP provider
FFmpeg
native CLI
model download
remote API
```

---

# 78. Subprocess запускается через одну infrastructure boundary

Например:

```text
ProcessRunner
```

который управляет:

```text
start
stdout/stderr
timeout
cancel
kill tree
exit code
```

---

# 79. Не писать `subprocess.Popen` повсюду

Все subprocess rules централизованы.

---

# 80. Async используется только по назначению

Async подходит для:

```text
HTTP
SSE
network I/O
```

---

# 81. CPU-heavy operation не выполняется в FastAPI event loop

Например:

```text
AI
large parsing
heavy NumPy CPU
FFmpeg orchestration wait
```

выносится в job/worker.

---

# 82. `async def` не делает CPU-код асинхронным

Запрещено заворачивать тяжёлый computation в async-функцию без execution strategy.

---

# 83. Sync/async boundary должна быть очевидной

Не смешивать хаотично:

```text
async → thread → async → process → callback
```

без необходимости.

---

# 84. CPU vs Thread vs Process выбирается осознанно

Правило:

```text
network I/O
→ async

blocking light I/O
→ thread when appropriate

pure Python CPU-heavy
→ process/native

PyTorch/NumPy/FFmpeg
→ их native runtime/job execution
```

---

# 85. AI providers изолированы

Pipeline работает через capabilities:

```text
Separator
AsrEngine
Aligner
PitchEngine
```

---

# 86. Pipeline не знает конкретное имя модели

Implementation выбирается через provider registry/composition.

---

# 87. AIProvider сообщает capabilities

```text
providerId
version
capabilities
supportedLanguages
requiredModels
requiredResources
```

---

# 88. Inference implementation отдельно от orchestration

Не делать один `pipeline.py` с:

```text
business logic
+
PyTorch internals
+
filesystem
+
DB
```

---

# 89. Model lifecycle отдельный subsystem

```text
download
verify
select
load
unload
```

не живут внутри processing pipeline.

---

# 90. Model lazy loading

Модель загружается при необходимости.

---

# 91. Model unload policy explicit

Например:

```text
on memory pressure
after stage
after idle timeout
```

---

# 92. ResourceBudget один

Один authoritative component определяет:

```text
CPU threads
RAM budget
GPU/VRAM policy
parallel jobs
```

---

# 93. Hardware detection один раз

Не делать:

```text
torch.cuda.is_available()
```

по десяткам modules.

Hardware snapshot создаётся централизованно.

---

# 94. Cache centralized

Processing cache управляется одним subsystem.

---

# 95. Cache key versioned

Должен учитывать:

```text
input hash
model/version/checksum
algorithm version
relevant configuration
```

---

# 96. Cache не source of truth

Cache можно удалить без потери canonical data.

---

# 97. Cache hit валидируется

Наличие файла != valid cache entry.

---

# 98. Filesystem через storage layer

Не создавать paths вручную по всему backend.

---

# 99. Typed/logical roots

Использовать:

```text
SongsRoot
ModelsRoot
CacheRoot
RecordingsRoot
TempRoot
```

---

# 100. Path normalization centralized

Никаких разных path rules в каждом domain.

---

# 101. External path недоверенный

Сначала:

```text
normalize
validate
authorize
```

---

# 102. File ownership explicit

Для любого persistent файла понятно:

```text
creator
owner
reader
writer
deleter
```

---

# 103. Temporary files scoped

Temp resource создаётся внутри operation scope и имеет cleanup strategy.

---

# 104. Cleanup idempotent

Повтор cleanup безопасен.

---

# 105. Storage cleanup bounded

Temp/cache/log/history не растут бесконечно.

---

# 106. `utils.py` как свалка запрещён

Предпочитать:

```text
hashing.py
json_io.py
path_validation.py
```

---

# 107. Shared только действительно shared

Не выносить code в `shared` после первого повторения автоматически.

---

# 108. DRY не абсолют

Три понятные строки иногда лучше complicated abstraction.

---

# 109. Abstraction только при semantic duplication

Не при просто похожем syntax.

---

# 110. Data-driven logic

Если различаются только значения:

```python
LABELS = {
    State.A: "...",
    State.B: "...",
}
```

---

# 111. Business behavior не прятать в giant mapping

Если branches имеют разные side effects — explicit functions лучше.

---

# 112. Magic numbers запрещены

Все policy values имеют имена:

```text
PACKAGE_SIZE_LIMIT
PROVIDER_TIMEOUT
JOB_QUEUE_CAPACITY
HISTORY_RETENTION_DAYS
```

---

# 113. Все limits являются Policy

Не размазывать:

```text
30
5
100
1024
```

по implementation.

---

# 114. Limits централизованы по feature

Например:

```text
PackagePolicy
ProcessingPolicy
HistoryPolicy
ProviderPolicy
```

---

# 115. Naming конкретный

Предпочитать:

```text
publish_project
register_recording
validate_package
```

вместо:

```text
handle_data
process_item
run
do_work
```

---

# 116. Side effect виден из имени

`get_*` не должен неожиданно писать files/DB.

---

# 117. Query и Command концептуально разделены

```text
Query
→ reads

Command
→ changes
```

---

# 118. Read не запускает тяжёлую mutation скрыто

Например `get_project()` не должен тихо делать huge migration без явного lifecycle contract.

---

# 119. Serialization centralized

Conversion:

```text
Enum ↔ JSON
datetime ↔ JSON
DTO ↔ Domain
```

не размазывается по routers/services.

---

# 120. UTC timestamps

Все persistent timestamps:

```text
UTC
```

---

# 121. UTF-8

Все canonical text files:

```text
UTF-8
```

---

# 122. Import-time side effects запрещены

`import module` не делает:

```text
DB connect
thread start
model load
filesystem mutation
network request
```

---

# 123. Startup side effects только через bootstrap

Composition и lifecycle находятся в понятном:

```text
bootstrap/
```

---

# 124. Composition Root один

Concrete dependencies создаются централизованно.

---

# 125. Domain не создаёт infrastructure

Не:

```python
repo = SqlAlchemySongRepository()
```

внутри use-case.

Dependency передаётся снаружи.

---

# 126. DI framework не нужен без причины

Constructor/function injection достаточно.

---

# 127. Circular import нельзя "лечить" local import

Плохо:

```python
def f():
    from other_module import x
```

если это сделано только ради устранения architecture cycle.

Cycle нужно исправить.

---

# 128. `__init__.py` минимален

Не использовать его как магический dependency hub.

---

# 129. Dynamic monkey patching запрещён

Production architecture не должна зависеть от runtime monkey patch.

---

# 130. Large data boundary explicit

Большие:

```text
NumPy arrays
Torch tensors
PCM arrays
large JSON
```

не должны бездумно копироваться через 5 application layers.

---

# 131. Передавать большие данные по shortest meaningful path

Например AI engine может возвращать typed result/reference, а не бесконечно сериализовать tensors в dict.

---

# 132. Streaming для больших файлов

Не читать целиком в RAM:

```text
audio files
packages
models
large exports
```

без необходимости.

---

# 133. Pagination обязательна

Для потенциально больших коллекций:

```text
songs
recordings
history
jobs
logs
```

---

# 134. List endpoint имеет limit

Никакой endpoint случайно не возвращает 100 000 objects.

---

# 135. Query performance проектируется заранее

Для large Library:

```text
indexes
projection
pagination
deterministic order
```

---

# 136. ORM lazy loading не используется как невидимый query engine

Queries должны быть понятны из repository implementation.

---

# 137. External provider payload валидируется

HTTP 200 не означает valid result.

---

# 138. Provider adapter скрывает внешний формат

Domain не знает структуру LRCLIB/другого provider API.

---

# 139. Security boundaries explicit

Недоверенные:

```text
uploaded file
archive
provider response
path
JSON
```

валидируются на входе.

---

# 140. Не использовать `eval`

---

# 141. Untrusted pickle запрещён

Не загружать unsafe pickle/model artifacts из неизвестного источника.

---

# 142. Secret/token не попадает в logs

---

# 143. Structured logging

Контекст по возможности:

```text
requestId
correlationId
jobId
songId
stage
```

---

# 144. Не логировать огромные данные

Не писать:

```text
полный pitch array
весь lyrics document
весь provider response
```

без explicit diagnostic mode.

---

# 145. Logs bounded

```text
rotation
max size
retention
```

---

# 146. Metrics отдельно от logs

Durations/counters не должны зависеть от parsing логов.

---

# 147. Observability проектируется заранее

До implementation ответить:

```text
Как узнать state?
Как понять failure?
Как связать request/job?
Какие metrics важны?
```

---

# 148. Type hints обязательны

Public production API полностью typed.

---

# 149. `# type: ignore` требует причины

Не использовать как стандартный escape hatch.

---

# 150. Linter disable только локально

Не выключать полезное правило на весь проект ради одной проблемной строки.

---

# 151. Formatter/linter единый

Рекомендуемый baseline:

```text
Ruff
Ruff formatter
mypy или pyright
pytest
```

---

# 152. Comments объясняют WHY

Не описывать очевидный код.

---

# 153. Docstring описывает contract

Полезно документировать:

```text
invariants
failure semantics
ownership
non-obvious behavior
```

---

# 154. TODO должен быть конкретным

Не:

```text
TODO fix later
```

А:

```text
что нужно изменить
почему
условие удаления
```

---

# 155. Dead code удаляется

---

# 156. Commented-out code запрещён

Git хранит history.

---

# 157. Public API модуля минимален

Экспортировать только реально необходимое.

---

# 158. Deep imports чужого subsystem запрещены

Не импортировать internal implementation соседнего feature.

---

# 159. Каждый subsystem имеет public entry point

Например его application use-cases/contracts.

---

# 160. Circular dependencies запрещены

Не только import cycles, но и responsibility cycles.

---

# 161. Internal event bus не использовать без необходимости

Прямой вызов лучше event-driven maze, если decoupling не нужен.

---

# 162. SSE/WebSocket UI events ≠ внутренний event bus

Transport events для frontend не требуют event-driven архитектуры всего backend.

---

# 163. No callback spaghetti

Application flow должен читаться сверху вниз.

---

# 164. Clock injectable там, где время влияет на logic

Для deterministic tests.

---

# 165. UUID/random source injectable при необходимости

Для reproducible tests.

---

# 166. Unit tests следуют boundaries

Domain/application тестируется без real:

```text
GPU
network
filesystem
DB
```

где это возможно.

---

# 167. Integration tests проверяют infrastructure

Например:

```text
SQLite
Filesystem
FFmpeg
Package archive
AI adapter
```

---

# 168. Contract tests для ports

Например:

```text
SongRepositoryContract
LyricsProviderContract
```

---

# 169. Fake предпочтительнее excessive mock

---

# 170. 20 mocks в одном тесте = architecture warning

---

# 171. Sleep-based tests запрещены

Не:

```python
time.sleep(2)
```

для synchronization.

---

# 172. Regression test на каждый bug

```text
reproduce
↓
failing test
↓
fix
↓
passing test
```

---

# 173. Failure paths тестируются

Минимально:

```text
success
validation error
conflict
dependency failure
timeout
cancel
recovery where applicable
```

---

# 174. Fault injection для persistent flows

Тестировать:

```text
DB commit failure
file write failure
rename failure
provider failure
subprocess crash
disk full
```

---

# 175. Migration tests обязательны

Отдельно:

```text
DB migrations
settings migrations
project migrations
package migrations
```

---

# 176. Test fixtures маленькие

Не использовать огромные реальные songs там, где synthetic fixture проверяет contract.

---

# 177. Performance tests отдельно

Unit tests не являются benchmarks.

---

# 178. Architecture tests в CI

Автоматически проверять:

```text
forbidden imports
dependency direction
circular imports
file size
complexity
dead modules
duplicate protocol/schema definitions
```

---

# 179. Domain layer физически не может импортировать API

Это должен проверять CI, а не только code review.

---

# 180. File size CI gate

Например:

```text
>300
→ warning

>500
→ fail/requires explicit allowlist
```

для handwritten production code.

---

# 181. Complexity gate

Высокая cyclomatic/cognitive complexity требует refactor или documented justification.

---

# 182. Dependency-count warning

Модуль с огромным количеством unrelated imports проверяется как potential God Object.

---

# 183. Architecture allowlist минимален

Исключения для size/complexity должны быть редкими и documented.

---

# 184. Performance сначала измеряется

Не оптимизировать Python по ощущениям.

```text
profile
↓
measure
↓
identify bottleneck
↓
optimize
```

---

# 185. Native extension только после profiling

Не переносить код в C++ просто потому, что "C++ быстрее".

---

# 186. Resource ownership для больших AI data

Продумывать:

```text
кто владеет tensor
когда освобождается
когда модель unload
```

---

# 187. Memory pressure является нормальным state

CUDA OOM / RAM pressure должны превращаться в controlled failure/recovery, а не crash backend.

---

# 188. Architecture Review перед новой feature

Перед написанием кода определить:

```text
Owner
Data
Source of Truth
Use-case
Dependencies
Persistence
Lifecycle
Concurrency
Failure
Cancellation
Recovery
Observability
Resource budget
Tests
```

---

# 189. Порядок проектирования

```text
Ownership
↓
Data
↓
Contract
↓
Lifecycle
↓
Concurrency
↓
Failure
↓
Cancellation
↓
Recovery
↓
Observability
↓
Resource Budget
↓
Tests
↓
Implementation
```

---

# 190. Новую feature не добавлять автоматически в существующий Service

Первый вопрос:

```text
Это действительно та же ответственность?
```

Если нет — отдельный use-case/module/subsystem.

---

# 191. Complexity Budget

Перед merge новой feature ответить:

```text
Сколько новых concepts?
Сколько states?
Сколько dependencies?
Сколько branches?
Можно ли убрать что-то вместо добавления?
```

---

# 192. Код должен становиться проще после refactor

Refactor, который:

```text
увеличил число abstractions
увеличил nesting
увеличил indirection
```

без реального выигрыша — плохой refactor.

---

# 193. Не использовать design pattern ради design pattern

Pattern применяется только если решает конкретную проблему.

---

# 194. Explicit code предпочтительнее clever code

Код должен быть понятен разработчику без угадывания hidden behavior.

---

# 195. Feature Complete означает Cleanup Complete

PR не завершён, пока остались:

```text
old code
obsolete flag
unused dependency
dead adapter
dead test
temporary compatibility path
```

---

# 196. Definition of Done для Use-case

Должны быть определены:

```text
owner
input
output
state
validation
errors
persistence
transaction
concurrency
timeout
cancellation
recovery
observability
resource limits
tests
```

---

# 197. Definition of Done для Subsystem

Subsystem готов, если:

```text
маленький public API
один state owner
правильное dependency direction
bounded resources
failure model определён
recovery определён
tests отражают boundaries
нет God Module
нет dead path
```

---

# 198. Code Review Checklist

Перед merge:

```text
Можно ли сделать проще?

Есть ли второй Source of Truth?

Не появился ли God Service?

Не протёк ли SQLAlchemy/FastAPI/PyTorch implementation в Domain?

Нужна ли эта abstraction сейчас?

Есть ли один owner state?

DB transaction короткая?

Нет ли N+1 query?

Не передаётся ли Session в background job?

Не блокируется ли event loop?

Есть ли bounded queue/retry/timeout?

Что произойдёт при cancel?

Что произойдёт при crash?

Что произойдёт при duplicate request?

Что произойдёт при dependency failure?

Migration протестирована?

Старый код удалён?
```

---

# 199. Главное правило роста

Python Backend должен расти:

```text
ПО ГОРИЗОНТАЛИ
```

Например:

```text
новый independent capability
→ новый маленький use-case
→ minimal contract
→ tests
```

А не:

```text
новая feature
→ +200 строк в Service
→ ещё 7 flags
→ ещё 12 if
→ ещё global state
```

---

# 200. Главное правило простоты

Если выбор между:

```text
универсальной умной системой
```

и:

```text
простым explicit решением
```

выбирается простое решение, пока универсальность не доказана реальными требованиями.

---

# 201. Главный принцип Python Backend

```text
КОД ДОЛЖЕН БЫТЬ ПРОЩЕ ЗАДАЧИ,
КОТОРУЮ ОН РЕШАЕТ.
```

---

# 202. Финальная архитектурная политика

Обязательные свойства Python Backend:

```text
Domain-first

маленькие responsibilities

тонкий API

маленькие use-cases

никаких God Services

никакого mutable global state

explicit Source of Truth

короткие DB transactions

bounded resources

typed contracts

versioned persistent formats

recovery-first design

explicit concurrency

centralized jobs

centralized subprocess lifecycle

controlled async/sync boundaries

no N+1

no ORM leakage

no silent fallback

architecture CI gates

tests по boundaries

legacy удаляется сразу
```

---

# 203. Статус

```text
PYTHON BACKEND ARCHITECTURE RULES
=
LOCKED
```

Новые общие правила добавляются только если обнаружен новый реальный класс архитектурной проблемы.

Не расширять документ speculative-правилами без подтверждённой необходимости.
# Правило полной замены реализации

Если существующая реализация заменяется новой, в проекте не должно оставаться две полноценные реализации одной и той же обязанности.

Допустимый процесс:

```text
1. Создать новую реализацию.

2. Перевести на неё все call sites.

3. Перевести tests на новый contract.

4. Проверить, что старая реализация больше нигде не используется.

5. Удалить старую реализацию.

6. Удалить связанные:
   - старые tests;
   - adapters;
   - compatibility wrappers;
   - feature flags;
   - configuration;
   - dependencies;
   - imports;
   - dead schemas;
   - dead migrations/helpers;
   - obsolete documentation.

7. Выполнить repository-wide search
   по имени старого класса/module/function/config key.

8. Запустить:
   - architecture tests;
   - unit tests;
   - integration tests;
   - type checker;
   - linter.

9. Только после удаления старого пути
   замена считается завершённой.
```

---

## Запрещено

Нельзя оставлять:

```text
OldSongProcessor
NewSongProcessor

Pipeline
PipelineV2

PackageImporter
PackageImporterNew

ModelManager
ModelManager2

LegacyImplementation
NewImplementation
```

если новая реализация уже является основной.

---

## Нельзя оставлять старый код "на всякий случай"

Git уже хранит предыдущую реализацию.

Поэтому:

```text
старый код
≠ backup
```

Если новая реализация сломалась, предыдущую версию можно получить из Git.

---

## Temporary dual implementation

Две реализации допустимы только во время реальной миграции.

В таком случае обязательно указать:

```text
migration reason
owner
old implementation
new implementation
remaining call sites
removal condition
```

Например:

```text
Temporary migration:
PackageImporterOld → PackageImporter

Removal condition:
all package-format-v1 imports migrated
and compatibility tests pass.
```

---

## Temporary код должен быть заметным

Он не должен выглядеть как нормальная permanent architecture.

Например:

```text
LegacyPackageReader
```

допустим только если он реально нужен для чтения старого формата.

Но:

```text
LegacyPackageReader
```

не должен оставаться после окончания compatibility window.

---

## Новая версия не получает V2

Если переделывается:

```text
ProjectPublisher
```

не создавать permanent:

```text
ProjectPublisherV2
```

В конечном состоянии снова существует:

```text
ProjectPublisher
```

---

## Старый public contract тоже удаляется

Недостаточно удалить класс.

Нужно проверить:

```text
API routes
DTO
enums
config
DB fields
events
job types
feature flags
tests
fixtures
mocks
documentation
```

Если они существовали только ради старой реализации — они тоже удаляются.

---

## Dead compatibility wrappers запрещены

Не оставлять:

```python
def old_process_song(...):
    return new_process_song(...)
```

только потому, что старое имя когда-то существовало.

Если call sites переведены — wrapper удаляется.

---

## Deprecated имеет срок жизни

Если backward compatibility реально нужна:

```text
deprecatedSince
removalVersion
```

должны быть определены заранее.

Deprecated без removal condition запрещён.

---

## После refactor количество путей не должно расти

Если до refactor было:

```text
1 способ выполнить операцию
```

а после стало:

```text
old path
new path
compat path
fallback path
```

без необходимости — refactor считается незавершённым.

Целевое состояние снова:

```text
1 canonical path
```

---

## One Responsibility = One Canonical Implementation

Для одной обязанности должен существовать один основной implementation path.

Например:

```text
Project publication
→ ProjectPublisher

Package import
→ PackageImporter

Recording registration
→ RecordingRegistry
```

Не несколько параллельных вариантов, между которыми никто уже не понимает разницу.

---

## CI должен помогать находить legacy

По возможности автоматически проверять:

```text
forbidden old module imports
deprecated symbols
unused modules
unused dependencies
dead feature flags
duplicate implementations
```

---

## Definition of Done для refactor

Refactor считается завершённым только когда:

```text
новый путь работает
+
все consumers переведены
+
старый путь удалён
+
legacy dependencies удалены
+
tests обновлены
+
repository search чистый
```

Не:

```text
"новый код уже есть"
```

а:

```text
"в проекте остался только новый canonical path"
```

---

## Главный принцип
# Python Backend — правила универсальности по железу и устройствам

## 1. Главный принцип

Python Backend не пишется под конкретный компьютер.

Он принимает решения на основании:

```text
capabilities
resource limits
available runtime
provider requirements
```

---

## 2. Запрещено принимать решение по имени GPU

Плохо:

```python
if gpu_name == "RTX 3060":
    mode = "cuda"
```

---

## 3. Использовать capabilities

Например:

```text
CUDA available
VRAM available
FP16 support
provider supports CUDA
model requirements
```

---

## 4. Запрещена логика по бренду CPU

Не:

```text
Intel
AMD
Ryzen
Core i7
```

---

## 5. Использовать resource characteristics

```text
logicalCpuCount
physicalCpuCount
availableRam
configuredThreadBudget
```

---

## 6. Hardware detection централизован

Создаётся один:

```text
HardwareCapabilities
```

snapshot.

---

## 7. Hardware detection не размазывается по модулям

Не делать:

```python
torch.cuda.is_available()
```

по всему проекту.

---

## 8. Один hardware subsystem отвечает за detection

---

## 9. Snapshot immutable в рамках операции

---

## 10. Processing job получает конкретный hardware/resource snapshot

---

## 11. `Auto` выбирает runtime через policy

Не через модель устройства.

---

## 12. Пример правильного выбора

```text
if CUDA available
and provider supports CUDA
and model supports selected precision
and required VRAM <= available budget
→ CUDA

else
→ CPU
```

---

## 13. CPU fallback policy explicit

---

## 14. Fallback observable

Если:

```text
CUDA → CPU
```

backend должен сообщить это в:

```text
processing report
diagnostics
logs
```

---

## 15. Никаких silent fallback

---

## 16. CPU thread count не hardcode

Плохо:

```python
threads = 8
```

---

## 17. Thread count рассчитывается через resource policy

---

## 18. Оставлять CPU headroom системе

---

## 19. Не использовать 100% логических ядер автоматически

---

## 20. RAM budget определяется runtime

---

## 21. VRAM budget определяется runtime

---

## 22. Не использовать всю доступную VRAM без safety margin

---

## 23. ResourceBudget централизован

Содержит:

```text
CPU budget
RAM budget
GPU budget
VRAM budget
parallel job limit
```

---

## 24. Processing scheduler использует ResourceBudget

---

## 25. AI provider описывает requirements

Например:

```text
required RAM
required VRAM
supported device
supported precision
supported language
```

---

## 26. Provider requirements проверяются до запуска

---

## 27. Не начинать job, если заранее известно, что он не помещается в ресурсы

---

## 28. Missing capability возвращает понятную ошибку

Например:

```text
UnsupportedComputeMode
InsufficientVram
MissingCuda
```

---

## 29. CUDA OOM — ожидаемый failure path

---

## 30. CUDA OOM не падает весь backend

---

## 31. Job получает controlled failure

---

## 32. Policy может позволять fallback

Но только explicit.

---

## 33. GPU reset/device loss должен давать controlled failure

---

## 34. Backend process должен оставаться жив, если возможно

---

## 35. Не оптимизировать под development machine

---

## 36. Development PC не является baseline

---

## 37. Не писать параметры под конкретную RTX/CPU

---

## 38. Не использовать hostname/machine name как business logic

---

## 39. Не использовать installed device name как processing rule

---

## 40. Hardware-specific workaround изолируется

Если реально нужен workaround:

```text
infrastructure/provider layer
```

---

## 41. Workaround не протекает в application/domain

---

## 42. Workaround документируется

Должно быть:

```text
affected hardware
affected driver/runtime
reason
condition
removal condition
```

---

## 43. Workaround должен быть максимально узким

---

## 44. Не использовать vendor check, если capability check достаточен

---

## 45. Backend работает CPU-only

Если требуемые local models поддерживают CPU mode.

---

## 46. CUDA является capability, а не requirement всего приложения

---

## 47. Отсутствие CUDA не ломает Library

---

## 48. Отсутствие CUDA не ломает Editor persistence

---

## 49. Отсутствие CUDA не ломает History

---

## 50. Capability degradation должна быть локальной

---

## 51. `Degraded` backend не означает «всё не работает»

---

## 52. Capabilities endpoint отражает текущее состояние

---

## 53. Hardware snapshot может пересоздаваться при изменении runtime

Например:

```text
driver reset
GPU unavailable
configuration change
```

---

## 54. Но job не должен видеть hardware snapshot, меняющийся хаотично посередине execution

---

## 55. Job uses consistent execution plan

---

## 56. Если capability пропала во время job

Job получает controlled error/recovery policy.

---

## 57. Processing contract одинаков на разном железе

API response schema не зависит от CPU/GPU модели.

---

## 58. Result formats одинаковы

---

## 59. Скорость может отличаться

---

## 60. Quality profile может отличаться только согласно выбранной processing policy

---

## 61. `Auto` может выбрать другой provider/profile

Но выбор должен быть observable.

---

## 62. `Fast` и `Quality` не должны означать одну конкретную модель hardware

---

## 63. Они описывают processing intent

---

## 64. Provider registry не привязан к одному GPU

---

## 65. Provider может объявить:

```text
cpu
cuda
both
```

---

## 66. Precision capability отдельно

Например:

```text
FP32
FP16
BF16
```

---

## 67. Не использовать FP16 автоматически только потому, что CUDA есть

Проверять provider/runtime support.

---

## 68. Device precision failure controlled

---

## 69. Hardware-specific paths профилируются

Не предполагается, что GPU path всегда быстрее.

---

## 70. Resource estimate до job

---

## 71. Estimate может быть conservative

---

## 72. Если estimate неизвестна

Не выдумывать точное значение.

---

## 73. Low RAM mode должен завершаться понятным failure/degraded profile

---

## 74. Low disk отдельно от RAM

Не смешивать resource types.

---

## 75. GPU memory и system RAM отдельно

---

## 76. CPU thread budget и process count отдельно

---

## 77. Не запускать параллельно тяжелые jobs только потому, что CPU многоядерный

---

## 78. Учитывать VRAM bottleneck

---

## 79. Scheduler должен запрещать oversubscription

---

## 80. HardwareCapability tests используют fake snapshots

---

## 81. Не требовать настоящую RTX в unit tests

---

## 82. Тестировать:

```text
CPU only
CUDA unavailable
CUDA available
low VRAM
high VRAM
FP16 unsupported
provider CPU-only
provider CUDA-only
```

---

## 83. Resource scheduler тестируется на fake budgets

---

## 84. Real hardware integration tests отдельные

---

## 85. Hardware-specific tests маркируются

---

## 86. CI основной suite не зависит от GPU

---

## 87. GPU suite отдельный

---

## 88. Не использовать конкретный device ID в unit tests

---

## 89. Hardware detection adapter тестируется отдельно

---

## 90. Application logic тестируется на capabilities abstraction

---

## 91. Не делать:

```python
if platform.processor() == ...
```

в domain/application.

---

## 92. OS-specific hardware integration — infrastructure concern

---

## 93. Не делать hardware detection внутри AI stage

Stage получает готовый execution context.

---

## 94. ExecutionContext может содержать:

```text
device
precision
threadBudget
memoryBudget
provider
```

---

## 95. ExecutionContext создаётся до stage execution

---

## 96. Не менять execution context случайно внутри stage

---

## 97. Model loader учитывает device capability

---

## 98. Model cache учитывает runtime/device where relevant

---

## 99. Cache key должен учитывать параметры, влияющие на результат

---

## 100. Но hardware model name не добавлять в cache key, если результат от него не зависит

---

## 101. Не инвалидировать cache просто из-за другого GPU без причины

---

## 102. Использовать algorithm/provider/version/config, а не hardware brand

---

## 103. Hardware diagnostics отдельно от business data

---

## 104. Diagnostics может показывать:

```text
GPU name
VRAM
CPU
RAM
CUDA version
```

---

## 105. Но domain logic не использует diagnostics display fields

---

## 106. Имя GPU — diagnostic metadata, не decision key

---

## 107. Имя CPU — diagnostic metadata, не decision key

---

## 108. Device vendor — diagnostic metadata, не business rule

---

## 109. Главный принцип

```text
PYTHON
НЕ СПРАШИВАЕТ:
"ЭТО RTX 3060?"

PYTHON СПРАШИВАЕТ:
"ЕСТЬ ЛИ CUDA?
ХВАТАЕТ ЛИ VRAM?
ПОДДЕРЖИВАЕТ ЛИ PROVIDER ЭТОТ RUNTIME?"
```

---

## 110. Обязательное правило

```text
HARDWARE-SPECIFIC APPLICATION LOGIC
ЗАПРЕЩЕНА,
ЕСЛИ РЕШЕНИЕ МОЖНО ВЫРАЗИТЬ
ЧЕРЕЗ CAPABILITIES / RESOURCE LIMITS / PROVIDER REQUIREMENTS.
```
