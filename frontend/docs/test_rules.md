# Frontend — эталонные правила тестирования

**Stack**

```text
React
TypeScript
Electron
Vitest
React Testing Library
Playwright
```

**Status**

```text
FRONTEND TESTING RULES
=
LOCKED
```

## 1. Главный принцип

```text
FEATURE DONE
=
CODE
+
TESTS
```

Тесты являются частью реализации feature.

---

## 2. Не писать весь frontend, а потом tests

Запрещён workflow:

```text
сделали feature
↓
сделали ещё 10 features
↓
в конце проекта начали писать tests
```

---

## 3. Не использовать TDD механически для всего

Нельзя требовать:

```text
каждая строка JSX
→ сначала failing test
```

Это создаст лишнюю работу без архитектурной пользы.

---

## 4. Test-first обязателен для pure logic

Сначала test, потом код для:

```text
reducers
state transitions
selectors
validation
mappings
sorting
filtering
normalization
permissions
capability gating
revision logic
event ordering
stale-event protection
```

---

## 5. State machine → test first

Например Karaoke:

```text
Preparing
→ Ready
→ Playing
→ Paused
→ Finished
```

Сначала тестируются допустимые переходы.

---

## 6. Invalid state transition тоже сначала фиксируется тестом

---

## 7. Reducer → test first

Reducer очень удобно проектировать через вход:

```text
State + Event
```

и ожидаемый:

```text
New State
```

---

## 8. Selector → test first, если содержит настоящую логику

---

## 9. Простому selector test может быть не нужен

Например:

```ts
song => song.title
```

не требует бессмысленного unit test.

---

## 10. Mapping с business meaning → test first

Например:

```text
SongStatus → allowed actions
```

---

## 11. Bug fix → failing test first

Обязательный порядок:

```text
воспроизвести баг
↓
написать failing test
↓
убедиться, что падает
↓
исправить
↓
test green
```

---

## 12. Bug fix без regression test считается незавершённым

Если bug можно автоматизированно воспроизвести.

---

## 13. UI layout обычно можно писать первым

Для чисто визуального:

```text
PageHeader
Card
Toolbar
Section
```

сначала component.

Потом сразу нужные tests поведения/accessibility.

---

## 14. Не писать test first ради проверки цвета margin

---

## 15. Не тестировать CSS implementation detail без необходимости

---

## 16. Component test проверяет поведение

Не внутреннее устройство.

---

## 17. Тестировать то, что видит/делает пользователь

Например:

```text
кнопка отображается
кнопка disabled
click вызывает action
ошибка отображается
dialog открывается
```

---

## 18. Не проверять private implementation

---

## 19. Не проверять число `useState`

---

## 20. Не проверять число `useEffect`

---

## 21. Не проверять имя внутренней функции

---

## 22. Refactor не должен ломать правильные behavioral tests

---

## 23. Component tests писать через React Testing Library

---

## 24. Не тестировать React component через его внутренний instance

---

## 25. Запросы к DOM делать как пользователь

Предпочитать:

```text
role
label
text
accessible name
```

---

## 26. `getByRole` предпочтительнее `querySelector`

---

## 27. `getByLabelText` для form control

---

## 28. `data-testid` использовать только если semantic selector неудобен/невозможен

---

## 29. Не строить все tests вокруг `data-testid`

---

## 30. Accessible UI автоматически становится проще тестировать

---

## 31. Не проверять DOM structure глубже, чем нужно

---

## 32. Не проверять class names без необходимости

---

## 33. Не проверять Fluent внутренние DOM classes

---

## 34. Не привязывать tests к internal Fluent markup

---

## 35. Component input/output contract важнее library internals

---

## 36. Один тест — одна логическая причина падения

---

## 37. Несколько assertions допустимы, если проверяют один сценарий

---

## 38. Не создавать test на весь экран со всеми возможными действиями

---

## 39. Большой screen разделять на scenarios

---

## 40. Arrange / Act / Assert должны быть очевидны

---

## 41. Не обязательно писать комментарии AAA

---

## 42. Test name описывает behavior

Хорошо:

```ts
it("disables Start while participants are not ready", ...)
```

Плохо:

```ts
it("works", ...)
```

---

## 43. Название теста отвечает:

```text
при каком условии?
что происходит?
```

---

## 44. Unit tests должны быть быстрыми

---

## 45. Pure TS unit test не должен монтировать React

---

## 46. Не рендерить component ради проверки простой функции

---

## 47. Pure function тестировать напрямую

---

## 48. Component logic, которую трудно тестировать без огромного render setup, вероятно стоит вынести

---

## 49. Но не выносить каждую строку component только ради tests

---

# Test layers

## 50. Использовать четыре основных слоя

```text
Unit
Component
Contract/Integration
E2E
```

---

## 51. Unit tests

Для:

```text
pure functions
reducers
selectors
state machines
mappers
formatters с логикой
policies
```

---

## 52. Component tests

Для:

```text
React behavior
forms
dialogs
buttons
visibility
accessibility
feature interactions
```

---

## 53. Contract/Integration tests

Для:

```text
Python client
AudioService client
Electron preload
IPC contracts
event streams
runtime validation
```

---

## 54. E2E

Для ключевых пользовательских flows.

---

## 55. Не тестировать всё через Playwright

---

## 56. E2E дорогие и медленные

---

## 57. Основной объём tests должен быть ниже E2E layer

---

## 58. Не дублировать каждый unit case в E2E

---

# Pure TypeScript logic

## 59. State transitions parameterize

```ts
it.each([
  ...
])(...)
```

если проверяется одна таблица переходов.

---

## 60. Не делать loop внутри test, если `it.each` даст отдельное падение

---

## 61. Edge cases обязательны для важной логики

---

## 62. Empty array

---

## 63. Single item

---

## 64. Unknown state

---

## 65. Boundary value

---

## 66. Duplicate ID

---

## 67. Missing optional field

---

## 68. Unexpected event ordering

---

# React state

## 69. Проверять meaningful state, а не setter

---

## 70. Не mock `setState`

---

## 71. Не проверять:

```text
setState called exactly once
```

если пользовательское поведение важнее.

---

## 72. Проверять результат render/action

---

## 73. High-frequency state logic должна иметь отдельные tests

---

## 74. Проверить coalescing realtime events

Например:

```text
100 position events
→ UI использует последний snapshot
```

---

## 75. Проверить, что stale snapshot не перезаписывает новый

---

## 76. Проверить generationId/revision logic

---

## 77. Проверить event ordering

---

## 78. Проверить burst событий

---

## 79. Не нужно реально отправлять миллион событий

Маленький deterministic набор достаточен для contract.

---

## 80. Проверить, что fast telemetry не вызывает semantic state corruption

---

# Async

## 81. Async race tests обязательны

Пример:

```text
load Song A
load Song B
response B
response A
```

Final UI должен показывать B.

---

## 82. Stale response test first для client-switch logic

---

## 83. Abort tests

Проверить:

```text
request started
route changed
request aborted
```

---

## 84. Abort не отображается как user-facing failure

---

## 85. Не использовать real `setTimeout` waits без необходимости

---

## 86. Использовать fake timers для debounce/throttle

---

## 87. Не писать:

```ts
await new Promise(resolve => setTimeout(resolve, 1000));
```

в обычном test.

---

## 88. Debounce test использует fake timer

---

## 89. Retry backoff test использует fake timer

---

## 90. Search debounce проверяется детерминированно

---

## 91. No sleep-based tests

---

## 92. Promise resolve/reject контролировать вручную для race tests

---

## 93. Deferred Promise helper допустим для tests

---

## 94. Не использовать network latency случайно

---

# StrictMode

## 95. Critical subscription hooks тестировать в StrictMode

---

## 96. Проверить:

```text
mount
subscribe
cleanup
remount
subscribe
```

---

## 97. Не должно оставаться duplicate subscription

---

## 98. Не должно оставаться duplicate timer

---

## 99. Initialization должна быть idempotent

---

# Cleanup

## 100. Subscription cleanup тестировать

---

## 101. Timer cleanup тестировать

---

## 102. Event listener cleanup тестировать

---

## 103. Worker cleanup тестировать

---

## 104. Object URL revoke тестировать там, где это важный resource lifecycle

---

## 105. AbortController cleanup тестировать

---

## 106. После unmount callbacks не должны изменять UI state

---

# Hooks

## 107. Hook с чистой бизнес-логикой — test first

---

## 108. Hook wrapper над простым React API не требует бессмысленных tests

---

## 109. Hook tests должны проверять публичный result/actions

---

## 110. Не проверять internal refs/effects

---

## 111. Если hook требует 15 providers для теста — architecture warning

---

# Forms

## 112. Проверять initial values

---

## 113. Проверять validation

---

## 114. Проверять dirty state

---

## 115. Проверять successful submit

---

## 116. Проверять failed submit

---

## 117. Проверять double-submit protection

---

## 118. Проверять Apply/Discard

---

## 119. Проверять leave with dirty state

---

## 120. Revision conflict для Editor обязательно тестировать

---

## 121. Form tests не должны знать internal state library

---

# API clients

## 122. Python client имеет contract tests

---

## 123. Проверять правильный method

---

## 124. Правильный path

---

## 125. Правильный body

---

## 126. Правильные query params

---

## 127. Runtime response mapping

---

## 128. Error mapping

---

## 129. AbortSignal forwarding

---

## 130. Не проверять `fetch` во всех feature tests заново

---

## 131. Client contract тестируется один раз

---

## 132. Feature tests используют fake typed client

---

# AudioService client

## 133. Проверять command serialization

---

## 134. Response validation

---

## 135. Event parsing

---

## 136. Unknown event handling

---

## 137. generationId handling

---

## 138. reconnect

---

## 139. stale event rejection

---

## 140. protocol mismatch

---

# Electron preload

## 141. Preload API имеет contract tests

---

## 142. Renderer не получает raw Electron API

---

## 143. Проверять allowed methods

---

## 144. Проверять invalid payload rejection

---

## 145. Проверять external URL validation

---

## 146. Проверять path restrictions/custom protocol where applicable

---

# Mocks / Fakes

## 147. Предпочитать typed fake service clients

---

## 148. Не mock низкоуровневый fetch во всех component tests

---

## 149. Feature test обычно получает fake:

```text
PythonClient
AudioServiceClient
DesktopClient
```

---

## 150. Fake должен соблюдать real contract

---

## 151. Fake не должен позволять impossible states

---

## 152. Не создавать один MegaFakeApplication

---

## 153. Маленькие feature-specific fakes лучше

---

## 154. Mock использовать для interaction, если interaction сам является contract

---

## 155. Не проверять десятки `toHaveBeenCalledTimes`

---

## 156. Excessive mocks = architecture warning

---

# Accessibility

## 157. Проверять accessible names для important controls

---

## 158. Dialog focus behavior тестировать

---

## 159. Keyboard action тестировать

---

## 160. Disabled button semantics тестировать

---

## 161. Icon-only buttons должны иметь accessible label

---

## 162. Не делать accessibility отдельной ручной проверкой только перед релизом

---

# Keyboard shortcuts

## 163. Shortcut registry имеет unit tests

---

## 164. Проверить context priority

---

## 165. `Space` внутри input не запускает Karaoke

---

## 166. Dialog priority

---

## 167. Disabled context не обрабатывает shortcut

---

# Virtualization

## 168. Не тестировать internal virtualization library implementation

---

## 169. Проверять behavior вокруг virtualization

Например:

```text
selected Song остаётся выбранной после recycle
```

---

## 170. Stable keys

---

## 171. Empty state

---

## 172. Large list smoke test

---

# Localization

## 173. Не проверять каждую строку на каждом языке во всех tests

---

## 174. Проверить, что missing translation key обрабатывается по policy

---

## 175. Critical layout можно иметь visual tests отдельно, если действительно нужны

---

## 176. Не делать snapshot всех переводов через component tests

---

# Snapshot tests

## 177. Использовать редко

---

## 178. Огромные DOM snapshots запрещены

---

## 179. Snapshot должен быть маленьким и осмысленным

---

## 180. Не нажимать `update snapshots` автоматически без просмотра diff

---

## 181. Behavioral assertion предпочтительнее snapshot

---

# Visual testing

## 182. Visual regression полезен для:

```text
Karaoke layout
Editor
Themes
critical modal layering
```

если инфраструктура есть.

---

## 183. Не заменять behavioral tests screenshots

---

## 184. Visual test не должен быть единственным тестом кнопки

---

# E2E

## 185. E2E-01 Startup

```text
Electron starts
→ services ready
→ Library visible
```

---

## 186. E2E-02 Import Song

---

## 187. E2E-03 Process Song

---

## 188. E2E-04 Processing failure/retry

---

## 189. E2E-05 Open Karaoke

---

## 190. E2E-06 Play/Pause/Seek

---

## 191. E2E-07 Recording flow

---

## 192. E2E-08 Editor save/revision

---

## 193. E2E-09 Room preparation/start

---

## 194. E2E-10 Settings apply

---

## 195. E2E suite небольшая

---

## 196. Не создавать E2E на каждую маленькую кнопку

---

## 197. E2E проверяет user capability целиком

---

# Service failures

## 198. Python unavailable test

---

## 199. AudioService unavailable test

---

## 200. Reconnect test

---

## 201. AudioService restart during Karaoke

Ожидание:

```text
Playing
→ Paused/Recovered
```

не silent continue.

---

## 202. Python restart во время processing screen

UI заново получает authoritative job state.

---

## 203. Old snapshot после reconnect не используется

---

# Permissions / capabilities

## 204. Capability gating unit test

---

## 205. Unsupported feature hidden/disabled according to product policy

---

## 206. Room host permission tests

---

## 207. Guest не получает host action

---

## 208. Но frontend test не заменяет backend authority test

---

# Error states

## 209. Каждая feature тестирует meaningful error state

---

## 210. Unknown error fallback

---

## 211. Known error code mapping

---

## 212. Не проверять полный технический message, если он не contract

---

## 213. requestId/details могут отображаться в diagnostics/details

---

# Loading / Empty

## 214. Loading test

---

## 215. Empty test

---

## 216. Ready test

---

## 217. Error test

---

## 218. Infinite spinner prevention where timeout/state contract applies

---

# Component variants

## 219. Parameterized test использовать для простых variants

---

## 220. Не копировать почти одинаковые tests для каждого status

---

## 221. Но разные behavior branches лучше отдельными тестами

---

# Test data

## 222. Test factory для Song

Например:

```ts
makeSong({
  status: "ready"
});
```

---

## 223. Test factory имеет хорошие defaults

---

## 224. Important value указывать явно в test

---

## 225. Не создавать giant fixture object на 100 полей в каждом test

---

## 226. Но fake data должна соответствовать real contract

---

## 227. Не использовать `as Song` для создания неполного fake object

Плохо:

```ts
{} as Song
```

---

## 228. Test builder должен создавать valid entity

---

## 229. Invalid entity создавать только в test boundary validation

---

# Type-level tests

## 230. Не нужно тестировать TypeScript compiler обычным runtime test

---

## 231. Для сложных public generic contracts допустим compile-time/type tests

---

## 232. Но не делать type tests для очевидных interfaces

---

# Timers

## 233. Fake timers использовать только в tests, где timer — часть behavior

---

## 234. Не включать fake timers глобально на весь suite

---

## 235. `requestAnimationFrame` можно подменить deterministic scheduler в visual logic tests

---

## 236. Realtime interpolation test не должен зависеть от реального FPS машины

---

# State update overflow

## 237. Test high-frequency snapshots

Проверить:

```text
несколько snapshots до render tick
→ применяется latest
```

---

## 238. Test coalescing

---

## 239. Test throttle sampling

---

## 240. Test no unbounded queue

---

## 241. Test subscription cleanup после unmount

---

## 242. Test that irrelevant telemetry does not rerender unrelated component, если это critical performance contract

---

## 243. Не проверять render count повсюду

---

## 244. Render-count tests только для реально performance-critical boundary

---

# Performance

## 245. Unit tests не являются benchmark

---

## 246. Performance tests отдельны

---

## 247. Library with large dataset performance smoke test

---

## 248. Editor with many notes performance smoke test

---

## 249. Room with expected participant limit smoke test

---

## 250. Не использовать microbenchmark, который не отражает UX

---

# Security

## 251. Runtime validation тестировать invalid external payload

---

## 252. IPC malformed payload

---

## 253. External URL unsafe protocol

---

## 254. Custom protocol traversal

---

## 255. Unsafe HTML, если когда-нибудь supported rich content

---

## 256. Security rejection не должна иметь side effects

---

# CI

## 257. Каждый PR запускает TypeScript typecheck

---

## 258. ESLint

---

## 259. Unit tests

---

## 260. Component tests

---

## 261. Relevant contract tests

---

## 262. Architecture checks

---

## 263. E2E critical subset where practical

---

## 264. Heavy E2E может быть отдельным release gate

---

## 265. Test failure блокирует merge

---

## 266. Не игнорировать failing test ради merge

---

## 267. Flaky test считается bug

---

## 268. Не rerun flaky test до зелёного как решение

---

## 269. Причину flaky test исправлять

---

## 270. Permanent `skip` запрещён

---

## 271. `skip` требует причины

---

## 272. Temporary `todo`/`skip` имеет removal condition

---

# Coverage

## 273. Coverage — индикатор, не цель

---

## 274. 100% coverage не гарантирует правильные tests

---

## 275. Critical pure logic должна иметь высокую branch coverage

---

## 276. Presentation markup не нужно бессмысленно добивать до 100%

---

## 277. Branch coverage важна для state machine/reducer

---

## 278. Не писать tests только ради процента

---

# Refactor

## 279. Behavioral tests должны позволять refactor

---

## 280. Если правильный refactor ломает 100 tests из-за internal implementation — tests плохие

---

## 281. При замене component existing behavior tests должны пройти новой implementation

---

## 282. После перевода consumers старая implementation удаляется

---

## 283. Старые implementation-specific tests удаляются

---

## 284. Не оставлять:

```text
OldComponent tests
NewComponent tests
```

для одной canonical реализации.

---

## 285. Новый component должен пройти canonical behavior contract, если такой contract существует

---

# Test code quality

## 286. Test code подчиняется почти тем же правилам чистоты, что production

---

## 287. Не создавать test-файл на 3000 строк

---

## 288. Test helpers маленькие

---

## 289. Не создавать свой test framework внутри проекта

---

## 290. Не скрывать важные assertions в гигантском helper

---

## 291. Test должен быть понятен без чтения 10 helper files

---

## 292. Не переиспользовать test helper любой ценой

---

## 293. Немного duplication в tests допустимо ради ясности

---

# What to test first

## 294. Test first:

```text
state machines
reducers
selectors с логикой
permission policies
action matrices
event ordering
race protection
revision handling
bug fixes
```

---

## 295. Component first, tests immediately after:

```text
cards
toolbars
page layouts
dialogs
simple forms
Fluent compositions
```

---

## 296. Contract first:

```text
Python client
AudioService client
Electron preload
```

---

## 297. E2E after feature works:

```text
complete user flow
```

---

# Recommended workflow

## 298.

```text
1. Определить behavior.
2. Определить owner/source of truth.
3. Перечислить states.
4. Перечислить important cases.
5. Определить test layer.
```

---

## 299. Если это pure logic:

```text
failing test
↓
minimal code
↓
green
↓
refactor
```

---

## 300. Если это UI component:

```text
define public props/behavior
↓
build minimal component
↓
component behavior tests
↓
refactor
```

---

## 301. Если это external client:

```text
define typed contract
↓
contract tests
↓
implementation
↓
integration tests
```

---

## 302. Если это bug:

```text
reproduce
↓
failing regression test
↓
fix
↓
green
```

---

## 303. Если это full flow:

```text
feature components + logic ready
↓
E2E
```

---

# Definition of Done

## 304. Feature считается завершённой, когда проверены применимые:

```text
happy path
loading
empty
error
permissions
validation
double-submit
async race
cancel
reconnect
cleanup
accessibility
```

---

## 305. Не каждая feature требует всё

---

## 306. Но каждая категория должна быть осознанно рассмотрена

---

# Main rules

## 307.

```text
PURE LOGIC
→ TEST FIRST
```

---

## 308.

```text
BUG
→ REGRESSION TEST FIRST
```

---

## 309.

```text
UI COMPONENT
→ IMPLEMENT
→ TEST IMMEDIATELY
```

---

## 310.

```text
EXTERNAL CONTRACT
→ CONTRACT FIRST
→ IMPLEMENTATION
```

---

## 311.

```text
USER FLOW
→ E2E AFTER FEATURE EXISTS
```

---

## 312.

```text
DO NOT WRITE THE ENTIRE FRONTEND
AND TEST IT LATER
```

---

## 313.

```text
TEST BEHAVIOR
NOT IMPLEMENTATION
```

---

## 314.

```text
NO SLEEP-BASED TESTS
```

---

## 315.

```text
NO EXCESSIVE MOCKING
```

---

## 316.

```text
NO FLAKY TESTS
```

---

## 317.

```text
HARD-TO-TEST CODE
=
ARCHITECTURE WARNING
```

---

## 318.

```text
FEATURE WITHOUT IMPORTANT TESTS
=
INCOMPLETE FEATURE
```

---

# Final strategy

Для нового frontend:

```text
TypeScript pure logic
→ TDD

State transitions
→ TDD

Reducers
→ TDD

Race / stale event logic
→ TDD

Bug fixes
→ Test First

React visual component
→ Component First + Immediate Tests

Complex interactive component
→ Behavior defined first + tests during implementation

Python client
→ Contract First

AudioService client
→ Contract First

Electron preload
→ Contract First

Critical application flows
→ Playwright E2E
```

---

# Status

```text
FRONTEND TESTING RULES
=
LOCKED
```
