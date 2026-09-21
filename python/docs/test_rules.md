# Python Backend — эталонные правила тестирования

**Status:** `LOCKED`

## 1. Главный принцип

Тесты являются частью реализации, а не работой после реализации.

```text
FEATURE DONE
=
CODE
+
TESTS
```

Если код написан, а необходимые тесты отсутствуют:

```text
feature не завершена
```

---

# 2. Не использовать один подход для всего

Не требуется механически применять TDD ко всему Python backend.

Используется:

```text
TDD
→ pure/domain/critical logic

Implementation → immediate tests
→ infrastructure/integration boundaries
```

---

# 3. Когда тест пишется ДО кода

Тест сначала обязателен или предпочтителен для:

```text
domain rules
validation
state transitions
revision conflicts
cache-key logic
migration logic
project validation
package validation
transaction policies
retry policies
resource policies
sorting/filtering/search rules
lyrics/note invariants
recovery decisions
```

---

# 4. Почему здесь test-first

Потому что сначала фиксируется:

```text
что система должна делать
```

а implementation уже подстраивается под contract.

---

# 5. Когда implementation допустимо написать первым

Для:

```text
SQLAlchemy adapter
FFmpeg adapter
PyTorch adapter
filesystem integration
HTTP provider
CUDA integration
external library integration
```

можно сначала создать минимально работающий adapter.

Но тесты пишутся сразу после него.

---

# 6. Запрещён подход

```text
написать feature несколько дней
↓
закончить
↓
когда-нибудь добавить tests
```

---

# 7. Новый use-case начинается с cases

До implementation определить минимум:

```text
happy path
invalid input
not found
conflict
dependency failure
timeout
cancel
recovery
```

где они применимы.

---

# 8. Не обязательно сразу писать все edge tests

Сначала минимальный contract.

Затем расширять по мере реализации.

---

# 9. Red → Green → Refactor

Для TDD:

```text
RED
тест падает

GREEN
минимальный код делает тест зелёным

REFACTOR
упрощаем код без изменения поведения
```

---

# 10. Нельзя писать огромный implementation на стадии Green

Минимальный код должен закрывать конкретный contract.

---

# 11. После refactor все тесты остаются зелёными

---

# 12. Regression test сначала

Для каждого найденного бага:

```text
1. Написать тест, воспроизводящий баг.
2. Убедиться, что он падает.
3. Исправить код.
4. Убедиться, что тест проходит.
```

---

# 13. Не исправлять известный bug без regression test

Исключение — если объективно невозможно автоматизировать сценарий.

Это должно быть обосновано.

---

# 14. Один тест — одна причина падения

Тест должен проверять одну логическую вещь.

---

# 15. Несколько assertions допустимы

Если они проверяют один результат.

Например:

```python
result = import_song(...)

assert result.song_id
assert result.title == "Song"
assert result.status is SongStatus.IMPORTED
```

Это один logical outcome.

---

# 16. Не делать тест на весь backend

Плохо:

```text
import
process
edit
export
record
analyze
delete
```

в одном test.

---

# 17. E2E отдельно

Большие пользовательские сценарии тестируются отдельным E2E layer.

---

# 18. Test Pyramid

Основной объём:

```text
много unit tests
↓
меньше integration tests
↓
ещё меньше E2E
```

---

# 19. Unit tests должны быть быстрыми

Обычные domain/application tests:

```text
milliseconds
```

а не секунды.

---

# 20. Unit test не запускает настоящий AI

---

# 21. Unit test не требует CUDA

---

# 22. Unit test обычно не требует FFmpeg

---

# 23. Unit test обычно не требует internet

---

# 24. Unit test обычно не требует реальной SQLite DB

Если проверяется domain logic.

---

# 25. Domain tests максимально pure

Например:

```text
note validation
revision conflict
state transition
package compatibility
```

должны тестироваться обычными Python objects.

---

# 26. Application test использует fakes

Use-case можно проверить через:

```text
FakeSongRepository
FakeProjectStore
FakeClock
FakeProvider
```

---

# 27. Fake предпочтительнее mock там, где возможно

Fake содержит маленькую рабочую реализацию contract.

---

# 28. Не mock everything

Если test требует 15–20 mocks:

```text
архитектуру нужно проверить
```

---

# 29. Mock использовать для interaction

Например проверить:

```text
provider вызван один раз
```

если именно interaction является contract.

---

# 30. Не проверять каждый внутренний вызов

Тестировать observable behavior.

---

# 31. Implementation detail не является contract

Если private function была переименована:

```text
unit tests не должны массово ломаться
```

---

# 32. Private functions обычно тестируются через public behavior

---

# 33. Отдельно тестировать private pure algorithm допустимо

Если это действительно самостоятельный сложный алгоритм.

Лучше тогда рассмотреть выделение его в отдельный module/public internal contract.

---

# 34. Test naming описывает поведение

Хорошо:

```python
def test_save_editor_rejects_stale_revision():
```

Плохо:

```python
def test_editor_1():
```

---

# 35. Имена тестов должны отвечать

```text
что?
при каком условии?
какой результат?
```

---

# 36. Arrange / Act / Assert

Структура:

```text
Arrange
Act
Assert
```

должна быть очевидна.

---

# 37. Не обязательно писать комментарии AAA

Если разделение и так очевидно.

---

# 38. Setup минимальный

Тест не должен содержать 50 строк подготовки для проверки одной строки behavior.

---

# 39. Fixture используется для настоящего общего setup

---

# 40. Не превращать `conftest.py` в второй backend

---

# 41. Fixture должна иметь понятный scope

```text
function
class
module
session
```

---

# 42. По умолчанию использовать function-scoped fixtures

---

# 43. Session fixture только для действительно дорогого immutable resource

---

# 44. Fixtures не должны скрывать важный state

Если test невозможно понять без открытия пяти fixtures — setup слишком магический.

---

# 45. Factory fixture часто лучше giant fixture

Например:

```python
song = make_song(status=SongStatus.READY)
```

---

# 46. Test builder должен иметь хорошие defaults

---

# 47. Но critical values теста указывать явно

Если test проверяет revision `5`, не прятать её глубоко в fixture.

---

# 48. Test data минимальные

Для note validation не нужен настоящий трёхминутный audio file.

---

# 49. Synthetic fixtures предпочтительны для algorithms

---

# 50. Реальные media fixtures нужны только integration tests

---

# 51. Test files тоже должны быть маленькими

Не создавать:

```text
test_everything.py
```

на 5000 строк.

---

# 52. Test structure отражает production boundaries

Например:

```text
tests/
├── unit/
│   ├── songs/
│   ├── projects/
│   ├── processing/
│   ├── lyrics/
│   └── packages/
│
├── integration/
│   ├── sqlite/
│   ├── filesystem/
│   ├── ffmpeg/
│   ├── ai/
│   └── providers/
│
├── contract/
│
└── e2e/
```

---

# 53. Не зеркалить production tree механически

Группировать tests по behavior/subsystem.

---

# 54. Test module target

Ориентир:

```text
50–300 строк
```

Если огромный — разделить по behavior.

---

# 55. Parameterization вместо копирования тестов

Если проверяется одно правило на разных inputs:

```python
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (...),
        (...),
    ],
)
```

---

# 56. Не параметризовать несвязанные сценарии

---

# 57. Parameterized row должна быть понятной

---

# 58. Добавлять `id=` для сложных cases

---

# 59. Табличные проверки подходят для

```text
state transitions
formats
compatibility
validation ranges
```

---

# 60. Не писать loop внутри test, если отдельные cases должны отображаться отдельно

Плохо:

```python
for value in values:
    assert validate(value)
```

Если один value упал — диагностировать сложнее.

Использовать parameterization.

---

# 61. `pytest.raises` для ожидаемых exceptions

```python
with pytest.raises(RevisionConflict):
    ...
```

---

# 62. Проверять meaningful exception data

Если contract содержит:

```text
expectedRevision
actualRevision
```

проверить их.

---

# 63. Не проверять полный human-readable текст без необходимости

Текст может меняться.

---

# 64. Проверять stable error code/type

---

# 65. Не использовать broad `pytest.raises(Exception)`

Кроме теста настоящей boundary, если это цель.

---

# 66. Snapshot tests использовать осторожно

---

# 67. Не snapshot-ить огромный JSON только потому, что это удобно

---

# 68. Для важного schema лучше explicit assertions

---

# 69. Snapshot хорош для большой стабильной presentation/schema output

если изменения должны осознанно review-иться.

---

# 70. Не обновлять snapshot автоматически, не проверив изменение

---

# 71. Deterministic tests обязательны

Одинаковый test должен давать одинаковый результат.

---

# 72. Не зависеть от порядка запуска tests

---

# 73. Test не зависит от результата предыдущего test

---

# 74. Test может запускаться отдельно

---

# 75. Не использовать общий mutable global test state

---

# 76. Не использовать настоящий current time напрямую

Если время влияет на logic:

```text
FakeClock
```

---

# 77. Не использовать random без seed/injected generator

---

# 78. UUID generator можно inject для deterministic tests

---

# 79. Не использовать `time.sleep()` для synchronization

---

# 80. Sleep-based tests запрещены

Вместо:

```python
time.sleep(1)
```

использовать:

```text
event
condition
fake clock
awaitable signal
```

---

# 81. Async tests должны ждать событие, а не время

---

# 82. Timeout в тестах обязателен для потенциально зависающих async/process operations

---

# 83. Test suite сама не должна зависать

---

# 84. Concurrency tests должны быть детерминированными насколько возможно

---

# 85. Race tests используют barriers/events

чтобы заставить операции попасть в нужный interleaving.

---

# 86. Не надеяться на случайное воспроизведение race

---

# 87. Lock behavior тестировать

Например:

```text
две editor save
→ одна получает RevisionConflict
```

---

# 88. Idempotency тестировать

Например:

```text
RegisterRecording(requestId=X)
RegisterRecording(requestId=X)
```

не создаёт две записи.

---

# 89. Duplicate request tests обязательны для create/register API

---

# 90. Transaction tests обязательны

Особенно DB + filesystem.

---

# 91. Проверить failure до DB commit

---

# 92. Проверить failure после temporary file creation

---

# 93. Проверить failed atomic rename

---

# 94. Проверить DB commit failure

---

# 95. После failure canonical old state должен быть корректен

---

# 96. Recovery tests обязательны для recovery logic

---

# 97. Не проверять recovery только вручную

---

# 98. Для crash-like tests можно подготовить filesystem/journal в состоянии «операция оборвалась»

и вызвать recovery.

---

# 99. Recovery повторяется безопасно

Test:

```text
recover
recover again
```

не повреждает состояние.

---

# 100. Cleanup idempotency тестировать

---

# 101. Migration tests обязательны для каждого supported version transition

---

# 102. DB migration tests

```text
old DB
→ migration
→ current schema
→ expected data
```

---

# 103. Project migration tests

---

# 104. Package migration/compatibility tests

---

# 105. Settings migration tests

---

# 106. Migration должна тестироваться и на failure

---

# 107. Migration не должна повреждать исходный project при failure

---

# 108. Backward compatibility тестируется только пока она официально поддерживается

---

# 109. После удаления compatibility path удалить соответствующие tests

---

# 110. Не хранить legacy test suite навечно

---

# 111. Repository contract tests

Каждая repository implementation проходит общий behavior contract.

Например:

```text
save
get
update
delete
not found
transaction behavior
```

---

# 112. Provider contract tests

Например LyricsProvider:

```text
valid result
not found
timeout
invalid payload
cancellation
```

---

# 113. AI Provider contract

Проверяет не качество модели, а integration contract:

```text
input accepted
output schema
errors
cancellation
metadata
```

---

# 114. Не запускать тяжёлую реальную AI model в каждом PR unit suite

---

# 115. Реальные AI integration tests выделить отдельно

---

# 116. Smoke AI test может использовать маленький fixture

---

# 117. GPU tests маркировать отдельно

Например:

```python
@pytest.mark.gpu
```

---

# 118. Network tests маркировать отдельно

---

# 119. Slow tests маркировать отдельно

---

# 120. Основной PR suite должен быть быстрым

---

# 121. Не делать тест «зелёным» через огромный timeout

Исправить нестабильность.

---

# 122. Flaky test считается bug

---

# 123. Нельзя просто rerun flaky test до зелёного

---

# 124. Нельзя игнорировать flaky test месяцами

---

# 125. Причина flaky test должна быть устранена

---

# 126. Integration DB tests должны использовать isolated DB

---

# 127. Каждый test получает чистое состояние

---

# 128. Не использовать developer DB

---

# 129. SQLite integration test должен работать с temporary database

---

# 130. Не проверять SQLAlchemy через mocks

Если нужно проверить SQLAlchemy repository — использовать реальную SQLite.

---

# 131. Repository unit test не нужен, если он просто повторяет ORM syntax

Проверять contract integration test.

---

# 132. Filesystem tests используют temporary directory

---

# 133. Не писать test artifacts в project repository directories

---

# 134. После test temporary resources очищаются

---

# 135. Но failing test artifacts можно сохранить только в explicit diagnostic mode

---

# 136. Path traversal обязательно тестировать для packages

---

# 137. Absolute-path archive entry тестировать

---

# 138. Unsafe symlink test

где platform поддерживает.

---

# 139. Oversized package policy тестировать без реально огромного файла

Использовать metadata/fake stream где возможно.

---

# 140. Corrupt archive тестировать

---

# 141. Invalid checksum test

---

# 142. SameRevision import idempotency test

---

# 143. OlderRevision conflict test

---

# 144. DivergentRevision test

---

# 145. lyricsSync schema tests

---

# 146. Note invariant tests

```text
start < word.start
end > word.end
end <= start
overlap
```

---

# 147. Boundary values особенно важны

Например:

```text
note.start == word.start
note.end == word.end
```

должны быть отдельно проверены.

---

# 148. Floating-point tests используют tolerance там, где это математически нужно

---

# 149. Не использовать приблизительное сравнение там, где значение должно быть exact

---

# 150. Property-based testing использовать для invariants

Для подходящих pure rules можно применять Hypothesis.

Например:

```text
note clipping
time ranges
serialization roundtrip
revision ordering
```

---

# 151. Не использовать property-based tests для всего подряд

---

# 152. Они особенно полезны там, где много combinations

---

# 153. Generated example, нашедший bug, сохранить как regression case при необходимости

---

# 154. Serialization round-trip тестировать

```text
Domain
→ serialize
→ deserialize
→ equivalent Domain
```

для canonical formats.

---

# 155. Не проверять только «JSON parses»

Проверять semantics.

---

# 156. API tests проверяют contract

```text
status code
error code
response schema
important fields
```

---

# 157. Не проверять внутренний service вызов в API test

---

# 158. API validation errors должны быть предсказуемыми

---

# 159. API version mismatch test

---

# 160. Pagination tests обязательны

Проверить:

```text
first page
next page
last page
empty page
stable order
```

---

# 161. Pagination не должна пропускать/дублировать записи при стабильном dataset

---

# 162. Search tests включают Unicode

Особенно:

```text
Ukrainian
Russian
English
```

---

# 163. Case-insensitive search тестируется

---

# 164. Deterministic sorting тестируется при одинаковом primary value

---

# 165. N+1 prevention

Для критичных list queries можно иметь query-count integration tests.

---

# 166. Не привязывать каждый repository test к точному SQL

Проверять performance contract, когда он важен.

---

# 167. Resource limit tests

Проверить:

```text
queue full
too many jobs
disk space insufficient
package too large
```

---

# 168. Не создавать реально заполненный диск

Storage dependency должна позволять fake space conditions.

---

# 169. Retry policy tests используют fake clock

---

# 170. Не ждать реальные backoff секунды

---

# 171. Проверить максимальное количество retry

---

# 172. Проверить terminal failure

---

# 173. Проверить success после временного failure

---

# 174. Timeout tests должны быть быстрыми

---

# 175. HTTP provider integration можно тестировать fake/local server

а не полагаться на реальный внешний сервис в PR suite.

---

# 176. Нельзя строить основной CI на доступности внешнего lyrics API

---

# 177. External live tests отдельные/manual/scheduled

---

# 178. Provider malformed response test

---

# 179. Provider rate-limit response test

---

# 180. Provider timeout test

---

# 181. Provider cancellation test

---

# 182. Offline mode tests

Проверить, что network-disabled состояние не ломает local capabilities.

---

# 183. Model registry tests

---

# 184. Partial model не становится Ready

---

# 185. Invalid checksum model test

---

# 186. Failed update не удаляет текущую working model

---

# 187. Missing required model определяется до heavy processing

---

# 188. Resource budget tests

Scheduler не запускает больше jobs, чем policy разрешает.

---

# 189. Не тестировать реальное потребление 8 GB VRAM в обычном unit suite

Тестировать scheduler policy отдельно.

---

# 190. CUDA OOM adapter test через controlled fake/error

---

# 191. Real CUDA OOM не нужен как регулярный CI case

---

# 192. Subprocess tests

Проверить:

```text
success
non-zero exit
timeout
cancel
stderr
```

---

# 193. Process tree termination integration test где возможно

---

# 194. Не запускать настоящий долгий FFmpeg process ради timeout test

Использовать маленький controlled subprocess.

---

# 195. FFmpeg contract integration test должен проверить реальный minimal media case

---

# 196. FFmpeg отсутствует → capability degraded test

---

# 197. Logging не должно быть главным assert механизма поведения

---

# 198. Лог можно проверять, если сам log является частью observability contract

---

# 199. Не проверять точный полный log text без необходимости

---

# 200. Проверять structured fields/level/event где возможно

---

# 201. Security tests обязательны для недоверенных inputs

---

# 202. Invalid path

---

# 203. Path outside allowed root

---

# 204. Malformed JSON

---

# 205. Oversized input

---

# 206. Unsafe archive

---

# 207. Unsupported format

---

# 208. Нельзя тестировать security только happy path

---

# 209. Tests должны подтверждать отсутствие side effect при rejected input

---

# 210. Delete tests

Проверить:

```text
successful delete
not found
conflicting active job
filesystem failure
DB failure
recovery
```

---

# 211. Quarantine pattern тестировать

---

# 212. После DB failure файл должен быть восстановим/сохранён согласно policy

---

# 213. Editor tests

Минимально:

```text
load
save
stale revision
invalid note
reset
concurrent save
```

---

# 214. Processing tests

Минимально:

```text
queue
start
progress
success
failure
cancel queued
cancel running
publication
old revision preserved
```

---

# 215. Analysis tests

Минимально:

```text
valid recording
incompatible revision
success
failure
stale result
```

---

# 216. Recording registry tests

```text
register
duplicate registration
orphan recovery
delete
missing file
```

---

# 217. Reconciliation tests

```text
DB exists / files exist
DB exists / files missing
orphan project
orphan recording
corrupt manifest
```

---

# 218. Reconciliation не должна угадывать исправление

Test должен подтверждать правильный recovery state.

---

# 219. Capabilities tests

Capabilities должны соответствовать реальному available dependency state.

---

# 220. Missing optional dependency не должен ломать unrelated capabilities

---

# 221. Startup tests

Проверить:

```text
valid startup
invalid config
DB migration
storage unavailable
instance lock conflict
recovery
degraded mode
```

---

# 222. Shutdown tests

Проверить:

```text
new jobs rejected
running jobs get signal
resources close
instance lock released
```

---

# 223. Import side-effect test

Простое:

```python
import backend.some_module
```

не должно:

```text
запускать thread
открывать DB
скачивать model
```

для модулей, где это критично.

---

# 224. Architecture tests

CI автоматически проверяет:

```text
domain не импортирует api
domain не импортирует concrete infrastructure
нет circular imports
```

---

# 225. Test architecture должна поддерживать production architecture

Не создавать test-only hacks, которые заставляют production code стать хуже.

---

# 226. Coverage используется как индикатор, а не цель

---

# 227. 100% coverage не означает хорошие tests

---

# 228. Низкая coverage critical domain означает проблему

---

# 229. Для pure critical modules целиться в очень высокую branch coverage

---

# 230. Для thin adapters процент менее важен, чем contract integration tests

---

# 231. Не писать бессмысленный test только ради coverage

Например:

```text
constructor creates object
```

если behavior отсутствует.

---

# 232. Branch coverage полезнее line coverage для business rules

---

# 233. Mutation testing можно применять выборочно

Особенно для:

```text
validation
state transitions
critical invariants
```

если suite зрелый.

---

# 234. CI tiers

Разделить:

```text
Fast
Integration
Heavy
```

---

# 235. Fast suite запускается на каждый PR

---

# 236. Integration suite тоже должна запускаться регулярно/на PR настолько, насколько практично

---

# 237. Heavy AI/GPU suite может запускаться отдельно

---

# 238. Но heavy tests не заменяют fast contract tests

---

# 239. Release gate включает ключевые integration/E2E tests

---

# 240. E2E проверяет пользовательскую цепочку, а не детали реализации

Например:

```text
Import
→ Process
→ Ready project
```

---

# 241. Не дублировать все unit cases в E2E

---

# 242. E2E должны быть немногочисленными и ценными

---

# 243. Test runtime контролируется

Если suite постепенно становится слишком медленной — это техническая проблема.

---

# 244. Slow test должен быть понятен как slow

---

# 245. Нельзя незаметно добавлять 30-секундный test в unit suite

---

# 246. Test output должен помогать понять failure

---

# 247. Не использовать generic assertions без контекста в сложных custom helpers

---

# 248. Custom assertions допустимы для повторяющихся domain checks

Например:

```python
assert_valid_project(project)
```

---

# 249. Но custom assertion не должен скрывать 50 несвязанных требований

---

# 250. Testing helper тоже должен быть простым

---

# 251. Test helper не импортируется production code

---

# 252. Production code не должен содержать специальные branches:

```python
if testing:
```

ради unit tests.

---

# 253. Dependency injection используется вместо test mode

---

# 254. Не менять production constants monkeypatch-ем повсюду

Лучше policy/config injection.

---

# 255. Monkeypatch подходит для узких infrastructure cases

Но не должен быть основной test architecture.

---

# 256. Golden files допустимы для stable canonical formats

Например known `lyricsSync.json`.

---

# 257. Golden file должен быть маленьким и reviewable

---

# 258. Не обновлять golden автоматически без просмотра diff

---

# 259. Test names не должны зависеть от task/bug номера только

Плохо:

```python
test_bug_123()
```

Лучше:

```python
test_failed_publication_keeps_previous_revision()
```

Bug ID можно добавить комментариями/metadata.

---

# 260. Regression test остаётся после исправления

---

# 261. Если implementation удалена — obsolete tests удаляются вместе с ней

---

# 262. Если behavior остаётся, test должен пережить refactor

---

# 263. Новая реализация проходит существующий contract suite

Это важная защита при замене старого кода.

---

# 264. Сначала перевести contract tests, потом удалить старую реализацию

---

# 265. Нельзя иметь permanent duplicate test suites:

```text
old tests
new tests
```

для одного canonical implementation.

---

# 266. При полной замене implementation

```text
новый код
↓
existing/new contract tests pass
↓
all callers switched
↓
old code deleted
↓
old implementation-specific tests deleted
```

---

# 267. Tests не должны препятствовать правильному cleanup legacy

---

# 268. Test doubles должны реализовывать тот же contract

---

# 269. Fake не должен иметь поведение, невозможное в real implementation

---

# 270. Fake repository должен по возможности соблюдать uniqueness/revision semantics

---

# 271. Иначе unit tests могут скрыть integration bug

---

# 272. Contract suite помогает держать fake и real implementations согласованными

---

# 273. Test database schema всегда current после migrations

---

# 274. Migration tests отдельно создают old schemas

---

# 275. Не хранить вручную огромные binary fixtures в repository без необходимости

---

# 276. Маленький WAV/FLAC fixture допустим для media integration

---

# 277. Generated deterministic audio fixture может быть лучше реальной песни

---

# 278. Не тестировать AI quality одной точной note sequence, если model inherently nondeterministic

---

# 279. Для AI quality использовать explicit tolerances/metrics и отдельный evaluation suite

---

# 280. Unit/contract test AI adapter проверяет structure, не художественное качество результата

---

# 281. Reproducibility metadata тестировать

Project report должен содержать expected:

```text
model id
model version
algorithm version
```

---

# 282. Cache-key tests критичны

Изменение:

```text
model
algorithm
relevant config
input
```

должно менять key.

---

# 283. Нерелевантное изменение не должно менять cache key без причины

---

# 284. Cache corruption test

Corrupt cached artifact не считается cache hit.

---

# 285. Cache deletion не ломает canonical project test

---

# 286. Disk-space preflight tests

---

# 287. Model-download preflight tests

---

# 288. Package preflight tests

---

# 289. Timezone tests

Persistent datetime должен быть UTC-aware.

---

# 290. Serialization tests не должны зависеть от local timezone машины CI

---

# 291. Locale tests

Где language имеет значение, проверить:

```text
uk
ru
en
auto
```

---

# 292. Unicode filenames test где filesystem behavior это допускает

---

# 293. Windows path semantics integration tests нужны, поскольку desktop target Windows

---

# 294. Но pure domain tests не должны зависеть от Windows

---

# 295. Tests должны различать platform-specific и platform-independent behavior

---

# 296. Markers для platform tests

---

# 297. Не `skip` silently важный test навсегда

Причина skip должна быть явной.

---

# 298. `xfail` использовать только для известного временного дефекта

---

# 299. Permanent `xfail` запрещён

---

# 300. Когда bug исправлен — убрать `xfail`

---

# 301. Code review теста так же важен, как production code

---

# 302. Сложный тест тоже требует refactor

---

# 303. Не писать тест умнее production algorithm

---

# 304. Expected result должен быть очевиден/независимо вычислим

---

# 305. Не копировать production implementation в test

Иначе обе версии могут содержать одинаковую ошибку.

---

# 306. Expected values получать из простого независимого правила

---

# 307. Для сложных algorithms использовать known cases/reference implementation только если она независима

---

# 308. Boundary conditions всегда проверять отдельно

---

# 309. Empty input

---

# 310. One element

---

# 311. Maximum allowed

---

# 312. Just below maximum

---

# 313. Just above maximum

---

# 314. `None` если допустим

---

# 315. Unicode/empty string если релевантно

---

# 316. Duplicate values

---

# 317. Invalid state transition

---

# 318. Test first особенно важен для boundary cases

---

# 319. Happy-path-only testing запрещён для critical code

---

# 320. Critical code определяется риском, а не количеством строк

---

# 321. Маленькая migration function может быть критичнее большого read-only API adapter

---

# 322. Test priority

```text
data loss risk
security
persistent corruption
state correctness
recovery
business correctness
performance
cosmetic
```

---

# 323. Persistent mutation требует более сильного test coverage, чем read-only query

---

# 324. Security-sensitive parser требует adversarial tests

---

# 325. Parser fuzz/property tests полезны для package/manifest inputs

---

# 326. Не фуззить всё подряд

---

# 327. Fuzzing особенно полезен на недоверенных parser boundaries

---

# 328. API schema tests могут генерироваться/валидироваться от canonical schema

---

# 329. Не поддерживать вручную две несовместимые версии test contract

---

# 330. Test configuration минимальна

---

# 331. Не создавать test environment, радикально отличный от production architecture

---

# 332. Но real external dependencies заменять controlled doubles там, где необходим deterministic test

---

# 333. Tests должны работать на clean checkout

---

# 334. Не зависеть от файлов на машине разработчика

---

# 335. Не зависеть от установленной вручную AI model в fast suite

---

# 336. Не зависеть от internet в fast suite

---

# 337. Не зависеть от порядка timezone/locale машины

---

# 338. Random port/path conflicts избегать через test-managed resources

---

# 339. Parallel test execution должна быть возможна для unit suite

---

# 340. Tests не используют одни и те же fixed temp filenames

---

# 341. Не использовать production storage root в tests

---

# 342. Database locks при parallel tests должны быть изолированы

---

# 343. Test suite должна явно показывать slowest tests

---

# 344. Периодически удалять tests, которые больше ничего полезного не защищают

---

# 345. Но не удалять regression tests только потому, что bug давно исправлен

---

# 346. Test duplication тоже technical debt

---

# 347. Если 20 tests повторяют один setup/assert pattern — улучшить factories/parameterization

---

# 348. Но не создавать giant generic test framework

---

# 349. Test helpers должны быть проще самих tests

---

# 350. Основное правило

```text
TEST DESCRIBES BEHAVIOR
NOT IMPLEMENTATION
```

---

# 351. Второе правило

```text
BUG FIX WITHOUT REGRESSION TEST
=
INCOMPLETE FIX
```

---

# 352. Третье правило

```text
CODE THAT IS HARD TO TEST
=
ARCHITECTURE WARNING
```

---

# 353. Четвёртое правило

```text
TESTS MUST BE DETERMINISTIC
```

---

# 354. Пятое правило

```text
DO NOT TEST EVERYTHING THROUGH E2E
```

---

# 355. Шестое правило

```text
DO NOT MOCK EVERYTHING
```

---

# 356. Седьмое правило

```text
PURE LOGIC
→ TEST FIRST
```

---

# 357. Восьмое правило

```text
INFRASTRUCTURE
→ MINIMAL IMPLEMENTATION
→ IMMEDIATE CONTRACT/INTEGRATION TEST
```

---

# 358. Девятое правило

```text
REFACTOR ONLY WHILE TESTS ARE GREEN
```

---

# 359. Десятое правило

```text
FEATURE IS NOT DONE
UNTIL ITS IMPORTANT FAILURE PATHS ARE TESTED
```

---

# 360. Практический workflow новой функции

```text
1. Определить contract.

2. Записать scenarios.

3. Определить, какие tests:
   unit
   contract
   integration
   E2E.

4. Для pure/critical logic:
   написать первый failing test.

5. Написать минимальный implementation.

6. Сделать test green.

7. Добавить следующий important case.

8. Повторять до закрытия contract.

9. Для infrastructure:
   написать минимальный adapter.

10. Немедленно написать contract/integration tests.

11. Добавить failure/cancel/timeout tests.

12. Refactor.

13. Запустить весь relevant suite.

14. Удалить старую implementation/tests,
    если новая implementation её заменила.

15. Feature ready.
```

---

# 361. Когда НЕ нужно писать тест до каждой строки

Не нужно делать:

```text
test
→ одна строка production
→ test
→ ещё одна строка
```

TDD работает на behavior/contracts, а не на количество строк.

---

# 362. Когда тест почти обязательно сначала

```text
bug
domain invariant
state machine
migration
revision conflict
serialization rule
security parser rule
cache identity
recovery decision
```

---

# 363. Когда код может быть первым

```text
новый внешний SDK adapter
эксперимент с AI library
FFmpeg invocation
SQLAlchemy query prototype
```

Но experimental spike не становится production code автоматически.

---

# 364. После spike

```text
понять правильный contract
↓
выбросить/очистить экспериментальный код
↓
написать production implementation
↓
добавить tests
```

---

# 365. Не строить tests вокруг случайной spike architecture

---

# 366. Definition of Done для тестов новой capability

Должны быть закрыты применимые:

```text
happy path
validation
boundary values
not found
conflict
duplicate/idempotency
dependency failure
timeout
cancel
transaction failure
recovery
migration
security
concurrency
```

---

# 367. Не каждый use-case требует все 13 категорий

Тестируется только применимое поведение.

---

# 368. Но пропуск категории должен быть осознанным

---

# 369. Test review checklist

Перед merge спросить:

```text
Что конкретно защищает этот test?

Сломается ли он при правильном refactor?

Есть ли test на основной failure path?

Есть ли boundary cases?

Нет ли sleep?

Нет ли зависимости от internet?

Нет ли excessive mocks?

Нет ли shared mutable state?

Проверяется ли behavior, а не private calls?

Если это bug fix — test действительно падал до fix?

Если это migration — проверяется старый format?

Если persistent mutation — проверен failure/recovery?

Если replacement — старые implementation-specific tests удалены?
```

---

# 370. Финальная стратегия

Для нового Python Backend:

```text
Domain / Pure Logic
→ TDD

Critical Persistence Logic
→ TDD

Bug Fixes
→ Regression Test First

Migrations
→ Test First

State Machines
→ Test First

Infrastructure Adapters
→ Minimal Implementation + Immediate Tests

AI/FFmpeg/SQLAlchemy Integrations
→ Contract + Integration Tests

Full User Flows
→ Small E2E Suite
```

---

# 371. Статус

```text
PYTHON BACKEND TESTING RULES
=
LOCKED
```
