# Python Backend — Greenfield Specification

**Status:** `LOCKED`

## 1. Назначение

Python Backend — локальный application backend A&D Voice.

Он отвечает за:

```text
данные
AI / ML
offline processing
persistent state
song projects
lyrics
editor persistence
packages
recording metadata
offline performance analysis
AI models
storage
history
room control
recovery
diagnostics
capabilities

```

Python Backend **не является audio engine**.

Все realtime/live audio принадлежит `AudioService.exe`.

---

# 2. Системная граница

```text
React
=
UI / presentation / interaction

Electron Main
=
desktop / OS / processes / filesystem bridge

Python Backend
=
data / AI / offline processing / persistence / product logic

AudioService.exe
=
all realtime / live media

```

Главное правило:

```text
Если функция работает с сохранёнными данными,
AI или offline-задачей
→ Python Backend

Если функция работает с живым звуком прямо сейчас
→ AudioService

```

---

# 3. Python никогда не реализует

```text
WASAPI
ASIO

microphone capture
monitoring

live playback
play / pause / seek runtime transport

realtime mixer
live DSP
live resampling

render clock
capture clock
drift correction

live recording PCM

remote voice media
voice codec
jitter buffer

live audio latency

```

---

# 4. Основные Python capabilities

```text
Song Library
Song Projects
Offline Processing
AI
Lyrics
Melody Editor Persistence
Project Revisions
Packages
Recording Registry
Offline Recording Analysis
AI Model Management
Storage
Settings
History
Room Control
Recovery
Diagnostics
Capabilities

```

---

# 5. Runtime

Целевая среда:

```text
Python 3.12
FastAPI
Pydantic
SQLAlchemy
SQLite
PyTorch
CUDA when available
FFmpeg

```

Конкретные AI engines могут меняться независимо от application architecture.

---

# 6. Greenfield структура

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
└── infrastructure/

```

---

# 7. Dependency direction

Концептуально:

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

Domain layer не зависит от:

```text
FastAPI
SQLAlchemy
PyTorch implementation
filesystem implementation
specific HTTP provider

```

---

# 8. API layer

Router делает только:

```text
validate request
↓
call use-case
↓
map result
↓
return response

```

Business logic не находится в routers.

---

# 9. Persistence layer

SQLAlchemy model — persistence representation.

Он не является domain model.

Используются отдельные:

```text
API DTO
Domain Model
Persistence Model

```

---

# 10. Backend lifecycle

Состояния:

```text
Starting
Ready
Degraded
Stopping
Failed

```

---

# 11. Startup

```text
Load Configuration
↓
Acquire Backend Instance Lock
↓
Validate Runtime
↓
Open Database
↓
Run DB Migrations
↓
Validate Storage Roots
↓
Recover Filesystem Transactions
↓
Recover Interrupted Jobs
↓
Reconcile Critical Persistent State
↓
Initialize AI Registry
↓
Validate Model Registry
↓
Start API
↓
Ready

```

---

# 12. Single backend ownership

Для одной library/database допускается один writer backend process.

При запуске создаётся:

```text
BackendInstanceLock

```

Второй backend не получает write ownership той же library.

---

# 13. Health endpoints

Разделяются:

```text
GET /health/live
GET /health/ready

```

`live` означает:

```text
process работает

```

`ready` означает:

```text
DB готова
migrations выполнены
storage usable
backend принимает application requests

```

---

# 14. Degraded mode

Отдельная capability может быть недоступна без падения всего backend.

Например:

```text
CUDA unavailable
ASR model missing
lyrics provider offline
FFmpeg unavailable

```

Library/metadata/history могут оставаться доступны.

---

# 15. Capabilities

Backend предоставляет:

```text
GET /capabilities

```

Пример:

```text
canImportSongs
canProcessSongs
canSeparate
canRunAsr
canRunAlignment
canAnalyzePitch
canAnalyzeRecording
canUseCuda
onlineLyricsAvailable
packageImportAvailable
packageExportAvailable

```

Frontend не угадывает возможности по ошибкам.

---

# 16. API version

Backend публикует:

```text
apiVersion

```

При несовместимости frontend получает явный:

```text
ApiVersionMismatch

```

---

# 17. Event delivery

Команды выполняются через HTTP/local API.

Для долгих операций используется event channel:

```text
SSE

```

или эквивалентный локальный event stream.

Через него передаются:

```text
processing progress
model download progress
analysis progress
package progress
important state changes

```

PCM через этот канал не передаётся.

---

# 18. Reconnect

После reconnect frontend всегда получает новый authoritative snapshot.

Frontend не продолжает доверять старому локальному state после backend restart.

---

# 19. Request identity

Для важных операций используются:

```text
requestId
jobId
correlationId

```

Они позволяют связать:

```text
API request
job
logs
processing report
error

```

---

# 20. Idempotency

Create/register operations, которые могут быть повторены после timeout, поддерживают idempotency.

Особенно:

```text
Import Song
Register Recording
Start Processing
Import Package

```

Повтор одного logical request не создаёт duplicate entity.

---

# 21. Song Library

Python является authoritative owner библиотеки песен.

Операции:

```text
Add
List
Get
Update Metadata
Delete
Search
Sort
Filter

```

---

# 22. Song identity

Каждая Song имеет стабильный:

```text
songId

```

Он не зависит от:

```text
filename
title
artist
path

```

---

# 23. Song entity

Минимально:

```text
songId

title
artist

sourceIdentity
sourceState

duration
language

coverState

status

activeRevision
projectFormatVersion

createdAt
updatedAt

```

---

# 24. Song status

```text
Imported
Queued
Processing
Cancelling
Cancelled
Ready
Failed
ProjectInvalid
SourceMissing

```

---

# 25. Source-file policy

С первого дня выбирается явный режим ownership.

Основная модель:

```text
CopyIntoLibrary

```

Исходный media-файл копируется в managed storage backend.

После успешного import библиотека не зависит от внешнего исходного пути.

---

# 26. Source identity

Отдельно существуют:

```text
SourceContentHash

```

и:

```text
ProjectRevision

```

Они не смешиваются.

---

# 27. Import Song

```text
Receive Selected File
↓
Validate Media
↓
Compute Source Identity
↓
Duplicate Check
↓
Extract Metadata
↓
Extract Artwork
↓
Copy Source Into Managed Storage
↓
Verify Copy
↓
Create Song Project
↓
Create DB Record
↓
Publish Imported Song

```

---

# 28. Import atomicity

Если import оборвался:

```text
Song DB record

```

и:

```text
managed source

```

не должны остаться в половинчатом состоянии.

---

# 29. Duplicate Detection

Использует content identity.

Filename не является достаточным признаком duplicate.

---

# 30. Duplicate result

```text
DuplicateSong
existingSongId

```

---

# 31. Metadata

Автоматически извлекаются:

```text
title
artist
album
duration
format
embedded artwork

```

---

# 32. Metadata provenance

Для важных полей может храниться:

```text
Embedded
Filename
Detected
User

```

---

# 33. User override

Ручное изменение:

```text
title
artist
language
cover

```

имеет приоритет над последующим automatic metadata enrichment.

---

# 34. Language

Поддерживаются:

```text
Auto
Ukrainian
Russian
English

```

`Auto` используется для automatic detection.

User override всегда имеет приоритет.

---

# 35. Language influence

Language применяется к:

```text
lyrics discovery
ASR
alignment
text normalization

```

---

# 36. Cover lifecycle

```text
Embedded
Custom
Fallback

```

Custom cover имеет приоритет.

---

# 37. Song Project

Каждая Song имеет managed project.

Он определяется:

```text
songId
activeRevision
projectFormatVersion

```

---

# 38. Project artifacts

Published project минимум содержит:

```text
instrumental audio
reference vocal
lyricsSync.json
manifest

```

---

# 39. Manifest

Manifest — canonical registry project artifacts.

Он содержит:

```text
artifact logical name
relative path
category
identity/checksum where needed
version/provenance where needed

```

---

# 40. Artifact categories

```text
Portable
LocalOnly
Temporary

```

---

# 41. Никаких filename fallbacks

Современный project использует manifest.

Backend не пытается угадывать artifact по цепочкам:

```text
vocals.wav
vocals.flac
vocal.wav
...

```

---

# 42. Project revision

Любое изменение canonical project content создаёт новую revision.

---

# 43. projectFormatVersion

Формат persistent проекта имеет отдельную версию.

---

# 44. Project compatibility

```text
Current
Upgradeable
TooNew
Unsupported
Invalid

```

---

# 45. Project migration

Upgrade проекта выполняется так:

```text
Detect Version
↓
Create Backup/Snapshot
↓
Migrate Into Transaction Area
↓
Validate Result
↓
Publish New Format
↓
Update Revision

```

---

# 46. Migration failure

При ошибке:

```text
original project

```

остаётся неизменённым.

---

# 47. lyricsSync.json

Canonical persistent document для:

```text
lyrics
word timing
notes
music metadata required by Karaoke/Editor

```

---

# 48. lyricsSync content

Минимально:

```text
title
artist
duration
bpm
key

lyrics

words:
  text
  start
  end
  notes

```

---

# 49. Note invariants

```text
note.start >= word.start
note.end <= word.end
note.end > note.start

```

Нелогичные overlaps запрещены validation.

---

# 50. Offline Processing

Processing полностью принадлежит Python Backend.

---

# 51. Processing modes

```text
Auto
Fast
Quality

```

---

# 52. Pipeline

```text
Probe
↓
Decode / Normalize
↓
Stem Separation
↓
Music Analysis
↓
Reference Vocal Preparation
↓
Lyrics Discovery
↓
ASR if required
↓
Forced Alignment
↓
Pitch Analysis
↓
Pitch Stabilization
↓
Voiced Interval Mapping
↓
Note Construction
↓
Project Validation
↓
Atomic Publication

```

---

# 53. Pipeline parallelism

Независимые stages могут выполняться параллельно.

Но parallel execution никогда не нарушает deterministic publication.

---

# 54. ProcessingJob

```text
jobId
songId
mode

state
stage

stageProgress
overallProgress

startedAt
updatedAt
finishedAt

error

```

---

# 55. Job states

```text
Queued
Running
Cancelling
Cancelled
Succeeded
Failed
Interrupted

```

---

# 56. Job Manager

С самого начала отдельны:

```text
ProcessingJobManager
PipelineOrchestrator
ProgressTracker
ProjectPublisher

```

Не создаётся один giant pipeline service.

---

# 57. Processing Queue

Concurrency ограничена resource budget.

---

# 58. Resource budget

Scheduler учитывает:

```text
CPU
RAM
GPU
VRAM

```

---

# 59. AudioService coexistence

Offline processing не должно ухудшать realtime работу AudioService.

Python processing не получает право использовать:

```text
100% CPU
all available RAM
all VRAM

```

без ограничений.

---

# 60. CPU budget

Backend оставляет system headroom.

CPU-intensive stages используют bounded thread count.

---

# 61. GPU budget

CUDA stages должны корректно переживать:

```text
CUDA OOM
driver reset
device unavailable

```

Ошибка одного job не завершает backend.

---

# 62. Model unload

Heavy model runtime может быть выгружен:

```text
after stage
between pipeline phases
on memory pressure
after idle timeout

```

согласно deterministic resource policy.

---

# 63. Cancellation

Queued job:

```text
Cancelled immediately

```

Running stage явно объявляет:

```text
Interruptible

```

или:

```text
FinishBeforeCancel

```

---

# 64. Subprocess ownership

Любой subprocess, запущенный backend:

```text
FFmpeg
AI helper
native CLI

```

имеет explicit owner.

На:

```text
Cancel
Shutdown
Job Failure

```

он корректно завершается.

---

# 65. Watchdogs

External process/provider operations имеют timeout там, где зависание возможно.

---

# 66. Crash resume semantics

После crash pipeline не продолжает произвольную функцию с середины.

Можно переиспользовать только:

```text
validated cached artifacts

```

---

# 67. Processing cache

Cache key включает:

```text
input identity
model identity/version
algorithm version
relevant parameters

```

---

# 68. Stale cache

Несовместимый cache не используется.

---

# 69. Processing provenance

Project/report сохраняет:

```text
modelId
modelVersion
modelChecksum
algorithmVersion
relevantParameters
runtime

```

---

# 70. Progress

Backend является authoritative owner:

```text
stage
stageProgress
overallProgress
elapsed
ETA if reliable

```

---

# 71. Processing report

После processing:

```text
stages
durations
models
runtime
cache usage
warnings

```

Report не является project source of truth.

---

# 72. Atomic publication

Все output сначала находятся в transaction area.

```text
Working Revision
↓
Validate
↓
Publish
↓
Update ActiveRevision

```

---

# 73. Failed processing

Существующая Ready revision не повреждается новой failed processing operation.

---

# 74. Full Reprocess

Перестраивает весь generated project.

---

# 75. Melody Reprocess

Повторяет только необходимые melody stages, используя существующие validated artifacts.

---

# 76. Lyrics Discovery

Порядок:

```text
Local Sidecar
↓
Embedded Lyrics
↓
Online Providers
↓
ASR

```

---

# 77. Lyrics Provider

Каждый provider имеет explicit adapter.

Он поддерживает:

```text
timeout
retry policy
rate-limit handling
cancellation
response validation

```

---

# 78. Offline mode

Если internet недоступен:

```text
online lyrics discovery

```

помечается unavailable.

Pipeline может использовать:

```text
local sources
ASR

```

при наличии локальных models.

---

# 79. Online provider failure

Один provider не ломает pipeline целиком.

---

# 80. Lyrics identity

Online result должен соответствовать song identity:

```text
title
artist
duration

```

на достаточном уровне.

---

# 81. ASR

ASR является offline AI capability.

Не требует internet после наличия local model.

---

# 82. AI Provider model

AI implementations подключаются через capabilities.

Например:

```text
AIProvider

providerId
version
capabilities
requiredResources
supportedLanguages
requiredModels

```

---

# 83. Capabilities AI provider

Например:

```text
Separation
ASR
Pitch
Alignment

```

Pipeline не зависит напрямую от имени конкретной модели.

---

# 84. Required model preflight

До начала processing backend знает:

```text
requiredModels

```

Если их нет:

```text
MissingRequiredModels

```

возвращается до тяжёлой обработки.

---

# 85. Forced Alignment

Синхронизирует words с reference vocal.

---

# 86. Word output

```text
text
start
end
confidence

```

---

# 87. Voiced interval refinement

Timing уточняется по фактическим voiced regions.

---

# 88. Pitch Analysis

Offline pitch result:

```text
time
frequency
confidence

```

---

# 89. Pitch Stabilization

Deterministic post-processing:

```text
confidence filtering
noise removal
subharmonic correction
contour stabilization
transition preservation

```

---

# 90. Note construction

Notes строятся только после pitch stabilization.

---

# 91. Melody Editor

Python хранит persistent editor state.

Audio preview не принадлежит Python.

---

# 92. Editor document

```text
songId
revision
duration
lyrics
words
notes
metadata

```

---

# 93. Editor Save

```text
Receive Document + ExpectedRevision
↓
Acquire Song Content Lock
↓
Check Revision
↓
Validate
↓
Write Transaction
↓
Atomic Publish
↓
Create New Revision

```

---

# 94. RevisionConflict

Silent overwrite запрещён.

---

# 95. Editor autosave

В v1 backend не выполняет скрытый automatic persistent autosave.

Frontend явно отправляет save operation.

Temporary UI drafts являются frontend concern, если продукт позже их потребует.

---

# 96. Editor Reset

Возвращает AI-generated baseline текущей processing lineage.

---

# 97. AI baseline

Baseline хранится отдельно от active user-edited content.

---

# 98. Lyrics mutation

Использует тот же:

```text
revision validation
content lock
atomic write

```

что Editor.

---

# 99. Project Validation

Проверяет:

```text
manifest
required artifacts
checksums where applicable
JSON schemas
audio readability
duration consistency
word timings
notes
revision metadata
project format

```

---

# 100. Validation on read

Validation выполняется не только при publication/import.

Если canonical artifacts изменены извне, backend должен уметь обнаружить corruption при доступе/reconciliation.

---

# 101. External filesystem mutation

Managed project directory не считается доверенным только потому, что backend его когда-то создал.

---

# 102. Library reconciliation

Поддерживается:

```text
Reconcile Library

```

Он сопоставляет:

```text
DB
filesystem
manifest

```

и обнаруживает:

```text
Missing Project
Orphan Project
Missing Artifact
Corrupt Artifact
Orphan Recording

```

---

# 103. Reconciliation не чинит данные наугад

Safe deterministic recovery выполняется автоматически.

Остальное помечается:

```text
RepairRequired
ReprocessRequired
ManualActionRequired

```

---

# 104. Project repair

Repair выполняется только если missing/corrupt data можно однозначно восстановить.

---

# 105. Song Packages

Portable package имеет versioned format.

---

# 106. Package Manifest

```text
packageVersion
projectFormatVersion

songIdentity
revision

artifact list
checksums

```

---

# 107. Package compatibility

```text
Current
Upgradeable
TooNew
Unsupported
Corrupt

```

---

# 108. Package Export

```text
Acquire Revision Snapshot
↓
Resolve Portable Artifacts
↓
Validate
↓
Build Archive
↓
Validate Archive
↓
Return

```

---

# 109. Package Import

```text
Receive Archive
↓
Security Validation
↓
Manifest Validation
↓
Compatibility Check
↓
Checksums
↓
Temporary Extraction
↓
Project Validation
↓
Conflict Resolution
↓
Atomic Publication
↓
DB Commit

```

---

# 110. Package security

Защита от:

```text
Path Traversal
Absolute Paths
Unsafe Symlinks
Zip Bomb
Unexpected File Count
Unexpected Size
Malformed Manifest
Checksum Failure

```

---

# 111. Import conflicts

Если package содержит existing song identity, backend различает:

```text
SameRevision
NewerRevision
OlderRevision
DivergentRevision

```

---

# 112. SameRevision

Import является idempotent и не создаёт duplicate.

---

# 113. OlderRevision

Не заменяет более новую canonical revision без explicit user choice.

---

# 114. NewerRevision

Может быть предложена как update проекта.

---

# 115. DivergentRevision

Не выполняется silent overwrite.

Возвращается conflict.

---

# 116. Recording boundary

AudioService создаёт actual recording file.

Python получает finalized:

```text
RecordingResult

```

---

# 117. RecordingResult

Минимально:

```text
recordingId
filePath
duration
sampleRate
channels
createdAt
gaps
session metadata

```

---

# 118. Recording storage ownership

Python определяет:

```text
Recording Storage Root

```

и создаёт разрешённый target descriptor/path до начала recording.

AudioService пишет только в переданную разрешённую destination.

---

# 119. Register Recording

После finalization:

```text
AudioService RecordingFinished
↓
RegisterRecording
↓
Python validates result
↓
Recording entity

```

---

# 120. RegisterRecording idempotency

Один `recordingId` может быть зарегистрирован только один раз.

Повтор возвращает существующий entity.

---

# 121. Orphan recording recovery

Если AudioService создал recording, а Python был недоступен:

```text
recording recovery descriptor

```

остаётся рядом с файлом или в agreed recovery location.

После старта Python выполняет reconciliation.

---

# 122. Recording reconciliation

Backend обнаруживает:

```text
recording file exists
metadata missing

```

и восстанавливает entity, если descriptor valid.

---

# 123. Recording Library

```text
List
Get
Get By Song
Delete

```

---

# 124. Recording deletion

Controlled transaction удаляет:

```text
metadata
owned file
analysis references

```

по product policy.

---

# 125. Song deletion

Recordings не удаляются автоматически вместе с Song, если явно не установлена другая product policy.

---

# 126. Offline Recording Analysis

Analysis работает только после finalization recording.

---

# 127. Analysis input

```text
Recording
Song Revision
Reference Melody

```

---

# 128. Input compatibility

Backend проверяет:

```text
recording song identity
expected song revision
timeline compatibility

```

---

# 129. Analysis result

Минимально:

```text
pitchAccuracyPercent
meanSemitoneDeviation
sectionResults
problemRegions

```

---

# 130. Analysis version

```text
algorithmVersion
songRevision
recordingIdentity

```

---

# 131. Analysis states

```text
NotStarted
Queued
Running
Succeeded
Failed
Stale

```

---

# 132. Stale Analysis

Если reference song revision изменилась, old analysis не выдаётся как актуальная без явного marker.

---

# 133. AI Model Registry

Единый registry содержит:

```text
modelId
purpose
version
size
checksum
state
localPath
selected

```

---

# 134. Model purposes

```text
Separation
ASR
Pitch
Alignment

```

---

# 135. Model states

```text
Missing
Downloading
Verifying
Ready
Failed
ModelUpdateAvailable

```

---

# 136. Model download

```text
Disk Preflight
↓
Download To Temporary Location
↓
Verify Size
↓
Verify Checksum
↓
Publish Atomically
↓
Ready

```

---

# 137. Model disk preflight

Учитывается:

```text
download size
temporary size
final size
safety margin

```

---

# 138. Partial models

Никогда не считаются Ready.

---

# 139. Model update

Новая версия не удаляет работающую current version до полной verification новой.

---

# 140. Compute mode

```text
Auto
CUDA
CPU

```

---

# 141. Compute diagnostics

```text
PyTorch
CUDA availability
CUDA runtime
GPU
VRAM
CPU
RAM
configured CPU threads
selected runtime

```

---

# 142. Storage

Backend владеет:

```text
Songs Root
Source Media
Models Root
Cache Root
Recording Root
Database
Temporary Transactions
Logs

```

---

# 143. Storage roots

Все roots:

```text
canonicalized
validated
permission checked

```

---

# 144. Storage path changes

Нельзя менять relevant root во время конфликтующей операции.

---

# 145. Conflict examples

```text
Processing
Model Download
Package Import
Package Export
Project Save
Recording Target Active

```

---

# 146. Disk Usage

Backend предоставляет:

```text
Free Space
Songs Usage
Models Usage
Cache Usage
Recordings Usage
Temp Usage

```

---

# 147. Large operation preflight

Перед:

```text
processing
model download
package import
package export

```

делается storage estimate.

---

# 148. Cache

Cache является regenerable storage.

---

# 149. Cache cleanup

Не удаляет:

```text
canonical project
user recording
source media
selected required models

```

---

# 150. Cache bounded

Используются:

```text
size limit
retention policy
LRU/age policy where suitable

```

---

# 151. Temp cleanup

Failed/cancelled operations оставляют cleanup marker.

Temp storage регулярно очищается.

---

# 152. Database

SQLite хранит persistent application metadata.

---

# 153. Core entities

```text
Song
Recording
AnalysisResult
ApplicationSettings
HistoryEvent
ProcessingJobHistory

```

---

# 154. DB migrations

Versioned и deterministic.

---

# 155. DB migration failure

Backend не продолжает normal write operation на неизвестной schema.

---

# 156. Settings schema

Persistent settings также имеют:

```text
settingsSchemaVersion

```

и migration.

---

# 157. Filesystem + DB transaction

Где операция меняет оба, используется controlled transaction strategy.

---

# 158. Quarantine delete

Для destructive operations:

```text
Move To Quarantine
↓
Commit DB
↓
Finalize Delete

```

где это оправдано.

---

# 159. Crash recovery

Backend должен переживать crash в:

```text
processing publication
editor save
package import
package export
model download
song deletion
recording registration

```

---

# 160. Recovery journal

Multi-step destructive/publication transaction может использовать small recovery journal.

---

# 161. Startup recovery

При старте backend:

```text
find interrupted transactions
↓
validate their state
↓
finish or rollback deterministically

```

---

# 162. SQLite corruption

Если DB cannot open/validate:

```text
Backend = Degraded/Failed

```

Canonical project files не удаляются.

Backend предоставляет recovery/diagnostic information.

---

# 163. Backups

Перед risky schema/project migration создаётся recoverable backup/snapshot.

---

# 164. Persistent Settings

Python хранит только backend settings:

```text
storage roots
compute mode
CPU budget
selected AI providers/models
network provider settings where applicable

```

---

# 165. Audio settings

Python не хранит authoritative:

```text
input device
output device
ASIO/WASAPI runtime state
monitoring
DSP live state

```

---

# 166. History

History — product events, не technical logs.

---

# 167. History examples

```text
SongImported
ProcessingStarted
ProcessingSucceeded
ProcessingFailed
RecordingRegistered
AnalysisCompleted
PackageImported
PackageExported

```

---

# 168. History pagination

History API обязательно paginated.

---

# 169. Recording pagination

Recording lists paginated.

---

# 170. Job pagination

Job history paginated.

---

# 171. Logs pagination

Technical logs не возвращаются неограниченным массивом.

---

# 172. Large Library

Library API рассчитан минимум на:

```text
10
100
1,000
10,000 songs

```

---

# 173. List contract

```text
search
filter
sort
cursor/pagination

```

---

# 174. Search

Минимально:

```text
title
artist

```

---

# 175. Search normalization

```text
Unicode-aware
case-insensitive
trimmed

```

---

# 176. Deterministic sort

Всегда имеет stable secondary key.

---

# 177. Logs

Используют:

```text
rotation
size limits
retention

```

---

# 178. Log privacy

По умолчанию logs не должны бесконтрольно сохранять:

```text
full lyrics
authentication tokens
raw provider responses
unnecessary absolute personal paths

```

Sensitive/large data логируется только при explicit diagnostic need.

---

# 179. Diagnostics

Отдельные области:

```text
Backend
AI
Processing
Storage
Versions
Recovery

```

---

# 180. Backend diagnostics

```text
API
DB
Scheduler
Instance Lock
Event Stream

```

---

# 181. AI diagnostics

```text
Providers
Models
PyTorch
CUDA
FFmpeg

```

---

# 182. Processing diagnostics

```text
Queue
Active Jobs
Resource Budget
Last Failures
Stage Durations

```

---

# 183. Storage diagnostics

```text
Roots
Permissions
Disk Space
Cache
Temp
Reconciliation State

```

---

# 184. Recovery diagnostics

```text
Interrupted Transactions
Recovered Jobs
Orphan Files
Orphan Recordings

```

---

# 185. Version diagnostics

```text
Backend Version
Python
API Version
DB Schema
Settings Schema
Project Format
Package Format
PyTorch
FFmpeg
Model Versions

```

---

# 186. Room Control

Python может владеть application/control plane online room.

---

# 187. Room owns

```text
Create Room
Join Room
Leave Room

Participant List
Host
Permissions

Selected Song
Selected Revision

Readiness
Control Commands

Project Transfer Coordination

```

---

# 188. Room does not own

```text
voice capture
voice codec
remote playout
jitter buffer
audio mixer

```

---

# 189. Participant

```text
participantId
displayName
role
connectionState
readinessState

```

---

# 190. Readiness

```text
MissingSong
Downloading
Importing
Preparing
Ready
Failed
Disconnected

```

---

# 191. Host authority

Room defines who may request:

```text
Select Song
Start
Pause
Seek
Stop

```

AudioService executes runtime playback.

---

# 192. Room revision

Room stores:

```text
songId
revision

```

Required participants must use that exact revision.

---

# 193. Project transfer

Missing revision:

```text
Export Package
↓
Transfer Coordination
↓
Import
↓
Validation
↓
Ready

```

---

# 194. Host disconnect

Product policy is explicit:

```text
Grace Period
↓
Host Transfer

```

or:

```text
Room Close

```

Не определяется случайным кодом.

---

# 195. Concurrency

Persistent write operations имеют explicit conflict rules.

---

# 196. Per-Song Content Lock

Применяется для:

```text
Editor Save
Lyrics Mutation
Project Publication
Repair
Package Revision Snapshot

```

---

# 197. Delete conflict

Delete Song нельзя выполнить одновременно с:

```text
Processing
Project Publication
Editor Save
Package Export
Repair

```

Backend возвращает conflict либо сначала выполняет explicit cancellation flow.

---

# 198. Reprocess conflict

Reprocess не запускается параллельно с другой project-mutating operation этой Song.

---

# 199. Global lock

Один giant global library lock не используется без необходимости.

Разные Songs должны работать независимо.

---

# 200. Background Jobs

Общая infrastructure:

```text
jobId
type
state
progress
cancel capability
error
timestamps

```

---

# 201. Job types

```text
SongProcessing
RecordingAnalysis
ModelDownload
PackageImport
PackageExport
LibraryReconciliation

```

---

# 202. Domain-specific behavior

Общий JobManager управляет lifecycle.

Domain implementation определяет реальную работу.

---

# 203. External network dependency

Backend чётко различает:

```text
Local Capability
Network Capability

```

---

# 204. Offline mode

При отсутствии сети продолжают работать:

```text
Library
Editor
Local Processing
ASR with installed model
Separation
Pitch
Alignment
History
Recording Analysis

```

---

# 205. Network-only capabilities

Например:

```text
online lyrics
model download
online room

```

явно помечаются unavailable.

---

# 206. Native offline helpers

Backend может использовать native library/CLI только там, где profiling показывает пользу.

---

# 207. Native candidates

Например:

```text
resampling
FFT
normalization
large deterministic DSP

```

---

# 208. Не переносить application backend в C++

Остаются Python:

```text
FastAPI
Library
AI orchestration
Project Transactions
Lyrics
Packages
History
SQLite
Room Control

```

---

# 209. FFmpeg

Используется для offline operations:

```text
probe
decode
conversion
validation

```

Не является live player.

---

# 210. Security

Даже local backend считает входные данные недоверенными.

---

# 211. Validation

Проверяются:

```text
IDs
payload sizes
paths
files
archives
JSON
provider responses

```

---

# 212. Paths

Renderer не может передать arbitrary path и заставить backend писать куда угодно.

---

# 213. Atomic writes

Canonical file:

```text
Write Temporary
↓
Flush
↓
Close
↓
Atomic Replace

```

---

# 214. Encoding

Canonical text artifacts:

```text
UTF-8

```

---

# 215. Persistent timestamps

```text
UTC ISO 8601

```

---

# 216. Error contract

```text
code
message
details
requestId/correlationId where relevant

```

---

# 217. Error examples

```text
SongNotFound
DuplicateSong

InvalidMedia
UnsupportedMedia
SourceMissing

ProcessingAlreadyRunning
ProcessingFailed
MissingRequiredModels

RevisionConflict
ProjectInvalid
ProjectUpgradeRequired
UnsupportedProjectVersion

ModelMissing
ModelDownloadFailed

InsufficientDiskSpace
StorageUnavailable

PackageInvalid
PackageConflict
PackageVersionUnsupported

RecordingNotFound
AnalysisFailed

RoomNotFound
RoomPermissionDenied

```

---

# 218. No tracebacks in normal API

Traceback остаётся только в technical diagnostics/logs.

---

# 219. Graceful shutdown

```text
Stop Accepting New Work
↓
Signal Jobs
↓
Cancel/Finish According To Policy
↓
Flush State
↓
Close DB
↓
Release Instance Lock
↓
Stop API

```

---

# 220. Stopping state

После входа в `Stopping` новые heavy jobs запрещены.

---

# 221. Main Song Flow

```text
Select Audio
↓
Import
↓
Song Entity
↓
Processing Job
↓
AI Pipeline
↓
Validate Project
↓
Atomic Publish
↓
Ready
↓
Frontend Opens Karaoke
↓
AudioService Handles Runtime Audio

```

---

# 222. Editor Flow

```text
Open Editor
↓
Get Document + Revision
↓
Edit
↓
Save ExpectedRevision
↓
Validate
↓
Publish New Revision

```

---

# 223. Recording Flow

```text
Python Allocates Recording Target
↓
AudioService Records
↓
AudioService Finalizes
↓
RecordingResult
↓
Python Registers
↓
Recording Library

```

---

# 224. Recording Failure Recovery

```text
AudioService Finalized File
↓
Python unavailable
↓
Recovery Descriptor remains
↓
Python restarts
↓
Recording Reconciliation
↓
Register Orphan Recording

```

---

# 225. Analysis Flow

```text
Recording
↓
Validate Compatibility
↓
Analysis Job
↓
Offline Analysis
↓
Versioned Result

```

---

# 226. Room Flow

```text
Host selects Song + Revision
↓
Participants validate local revision
↓
Transfer Missing Projects
↓
All required participants Ready
↓
Room authorizes Start
↓
AudioService executes media session

```

---

# 227. Главный architecture invariant

Python никогда не находится внутри per-buffer audio path.

```text
Audio callback
→ НЕ Python

```

---

# 228. Python может работать параллельно

Во время Karaoke Python может обслуживать:

```text
Library
History
Processing another Song
Package operations
Metadata

```

без участия в realtime audio.

---

# 229. Основная цель архитектуры

Backend должен быть:

```text
predictable
transactional
recoverable
versioned
observable
resource-bounded
testable

```

---

# 230. Definition of Done для Python capability

Новая capability считается готовой только если определены:

```text
ownership
API contract
domain model
persistence
validation
errors
concurrency
cancellation if applicable
recovery
observability
resource limits
tests

```

---

# 231. Запрещённые архитектурные формы

Не создавать:

```text
BackendService
AppManager
EverythingRepository
GlobalMutableConfig
God Pipeline Service
God Package Service

```

---

# 232. Правило размера ответственности

Модуль группируется по:

```text
одной предметной ответственности

```

а не просто по техническому типу.

---

# 233. Финальная граница

```text
PYTHON BACKEND

Library
Projects
AI
Processing
Lyrics
Editor Persistence
Packages
Recording Registry
Offline Analysis
Models
Storage
Settings
History
Room Control
Recovery
Diagnostics
Capabilities

```

```text
AUDIOSERVICE.EXE

Playback
Mic
Monitoring
Mixer
DSP
Recording PCM
Network Audio
Clocks
Latency
Realtime Diagnostics

```

---

# 234. Итоговый принцип

```text
Python Backend
=
Persistent Application + AI + Offline Processing Engine

AudioService
=
Realtime Media Engine

```

Эта граница является обязательной архитектурной частью проекта.

---

# 235. Specification state

На основании текущих требований A&D Voice:

```text
PYTHON BACKEND SPEC
=
LOCKED

```

Новые пункты добавляются только если появляется:

```text
новая функция продукта
новый внешний dependency
новое подтверждённое техническое ограничение

```

Не следует расширять backend speculative-функциями «на будущее».