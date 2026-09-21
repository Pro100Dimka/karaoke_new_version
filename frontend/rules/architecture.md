# Frontend — эталонные архитектурные правила

**Stack**

```text
React
TypeScript
Electron
Vite
Fluent UI
```

**Status**

```text
FRONTEND ARCHITECTURE RULES
=
LOCKED
```

---

# 1. Главная цель

Frontend должен оставаться:

```text
простым
маленьким
типизированным
предсказуемым
переиспользуемым
тестируемым
изолированным
```

даже после значительного роста продукта.

Главное правило:

```text
Новая функциональность
не должна превращать существующий компонент,
hook, context или store
в бесконечно растущий объект.
```

---

# 2. Frontend не является backend

Frontend отвечает за:

```text
presentation
interaction
local UI state
forms
navigation
visualization
```

Он не владеет:

```text
persistent business data
AI processing
live audio engine
filesystem
process lifecycle
```

---

# 3. Системные границы фиксированы

```text
React Renderer
→ UI

Electron Main
→ desktop / OS / process bridge

Python Backend
→ data / AI / offline processing / persistence

AudioService.exe
→ realtime / live media
```

Нельзя нарушать эти границы только потому, что так быстрее реализовать feature.

---

# 4. Один authoritative owner

Каждое состояние имеет одного владельца.

```text
Song status
→ Python

Project revision
→ Python

Playback position
→ AudioService

Recording runtime state
→ AudioService

Window state
→ Electron Main

Open modal
→ React
```

---

# 5. Второй Source of Truth запрещён

Если state уже authoritative во внешней системе, React не создаёт независимую копию истины.

React может хранить:

```text
snapshot
cache
draft
optimistic state
```

но ownership не меняется.

---

# 6. Derived state не хранить

Плохо:

```text
songs
filteredSongs
sortedSongs
visibleSongs
```

как четыре независимых `useState`.

Предпочитать вычисление через:

```text
selector
plain calculation
memo if needed
```

---

# 7. `useEffect` не используется для derived state

Не делать:

```text
state A
→ effect
→ set state B
```

если B можно вычислить из A.

---

# 8. `useEffect` только для side effects

Допустимые причины:

```text
subscription
external service
timer lifecycle
DOM integration
imperative API
resource cleanup
```

---

# 9. Если можно без `useEffect` — использовать без `useEffect`

---

# 10. Цепочки effects запрещены

Не строить:

```text
effect A
→ state B
→ effect B
→ state C
→ effect C
```

Такой flow должен стать явной operation/state machine.

---

# 11. React component отвечает за presentation

Компонент не должен одновременно:

```text
fetch
map API DTO
validate domain
manage audio
save
navigate
render
```

---

# 12. Composition component допустим

Но он только соединяет готовые части.

---

# 13. Размер компонентов

Ориентир:

```text
50–180 строк
→ нормально

180–250
→ проверить ответственность

250–350
→ вероятна декомпозиция

>350
→ по умолчанию архитектурная проблема
```

---

# 14. Не дробить искусственно

Не создавать компоненты по 5 строк только ради line limit.

Декомпозиция идёт по ответственности.

---

# 15. Component выделяется, если

```text
переиспользуется
имеет своё behavior
имеет отдельный lifecycle
имеет самостоятельный UI concept
существенно упрощает parent
```

---

# 16. Feature-first structure

Использовать:

```text
features/
  library/
  karaoke/
  editor/
  room/
  settings/
```

а не огромные глобальные:

```text
components/
hooks/
services/
utils/
```

---

# 17. Shared только действительно shared

В `shared` попадает то, что используется несколькими независимыми областями.

---

# 18. Shared UI не знает domain

`Button`, `Modal`, `Tabs`, `TextField` не знают про Song, Recording, Room.

---

# 19. Hook = одна ответственность

Хорошо:

```text
useSongSearch
usePlaybackSnapshot
useEditorHistory
```

Плохо:

```text
useApplicationController
useEverything
```

---

# 20. Hook на 300–400 строк — God Object

---

# 21. Plain function лучше hook, если React lifecycle не нужен

---

# 22. Context использовать ограниченно

Хорошие случаи:

```text
theme
service clients
small global UI capability
routing-level dependency
```

---

# 23. Context не является глобальной БД

---

# 24. Giant Context запрещён

Нельзя иметь один Context с:

```text
songs
room
audio
settings
notifications
processing
editor
```

---

# 25. Часто меняющийся state не складывать в один Context

Например:

```text
playback position
audio level
remote speaking levels
```

---

# 26. Для частых обновлений использовать selector-based subscription/store

---

# 27. React не получает каждую audio-frame update

UI получает ограниченную частоту snapshots.

---

# 28. Event storm должен coalesce/throttle

Старые playback/level events не должны накапливаться в renderer queue.

---

# 29. Renderer backpressure обязателен для высокочастотных событий

При поступлении нового snapshot старый неактуальный snapshot можно отбросить.

---

# 30. Animation interpolation не является authoritative time

---

# 31. Python client отдельно от React

---

# 32. AudioService client отдельно от React

---

# 33. Desktop client отдельно от React

---

# 34. Components не делают raw `fetch`

---

# 35. Components не делают raw IPC

---

# 36. IPC channel strings не должны гулять по приложению

---

# 37. API URLs не должны гулять по приложению

---

# 38. Typed client — единая точка transport contract

---

# 39. Python API contracts typed

---

# 40. AudioService protocol typed

---

# 41. Electron preload contract typed

---

# 42. TypeScript strict обязателен

```text
strict: true
```

---

# 43. Production `.js/.jsx` запрещены

Использовать:

```text
.ts
.tsx
```

---

# 44. Исключения только для vendor/generated/tooling where required

---

# 45. `any` запрещён по умолчанию

---

# 46. External payload начинается как `unknown`

---

# 47. `unknown` валидируется на boundary

---

# 48. `as any` запрещён

---

# 49. Type assertion не заменяет runtime validation

---

# 50. `@ts-ignore` запрещён по умолчанию

---

# 51. `@ts-expect-error` только с объяснением

---

# 52. Discriminated unions использовать для lifecycle state

Например:

```ts
type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: AppError };
```

---

# 53. Boolean soup запрещён

Плохо:

```text
isLoading
isReady
hasError
isEmpty
```

если это одно состояние.

---

# 54. Invalid state должен быть трудно представить

---

# 55. Props минимальны

Не передавать 20 props без причины.

---

# 56. Но giant object prop ради сокращения props тоже плох

---

# 57. Передавать component только то, что он реально использует

---

# 58. Props callbacks:

```text
onSave
onDelete
onSelect
```

---

# 59. Internal handlers:

```text
handleSave
handleDelete
```

---

# 60. Event handler не содержит большую application logic

Он вызывает feature operation.

---

# 61. Формы имеют Loaded/Draft separation

```text
loaded data
≠
draft data
```

---

# 62. Dirty вычисляется, а не поддерживается вручную, где возможно

---

# 63. Save явный

---

# 64. Structural settings не сохраняются на каждый keypress

---

# 65. Apply / Discard model используется где нужен

---

# 66. Backend validation остаётся authoritative

Frontend validation — UX layer.

---

# 67. Lifecycle flows моделируются явно

Например:

```text
Karaoke
Recording
Room readiness
Processing
```

---

# 68. State machine лучше десятка booleans

---

# 69. `useReducer` использовать только если state transitions действительно сложные

---

# 70. Reducer pure

---

# 71. Side effects внутри reducer запрещены

---

# 72. Action names описывают события

Хорошо:

```text
playbackStarted
recordingFinished
serviceDisconnected
```

---

# 73. Не использовать generic `SET_DATA`

для сложного lifecycle.

---

# 74. Global state library не вводится без реальной причины

---

# 75. Прежде чем брать store library, проверить:

```text
local state
props
context
external subscriptions
```

---

# 76. Один giant `appStore` запрещён

---

# 77. Store имеет feature/domain scope

---

# 78. Query cache имеет одного владельца

Не делать ручной duplicate cache поверх query library без причины.

---

# 79. Action matrices централизованы

Например:

```text
SongStatus → allowed actions
```

---

# 80. Presentation mappings data-driven

Например:

```text
status → label
status → icon
status → badge
```

---

# 81. Side-effect behavior не прятать в giant mapping

---

# 82. Routes централизованы

---

# 83. Route strings не размазываются по приложению

---

# 84. Route params typed

---

# 85. Page — composition root экрана, а не giant feature component

---

# 86. Page не содержит весь business flow

---

# 87. Fluent UI — основной design system

---

# 88. Не создавать собственный Button/Dialog/Input без причины

---

# 89. Custom wrapper создаётся только если добавляет общую policy

---

# 90. Не создавать wrapper только ради переименования одного prop

---

# 91. Не добавлять второй design system

Нельзя тащить MUI/Ant/etc. ради одного компонента.

---

# 92. Icon policy едина

Не использовать одновременно 4 icon libraries.

---

# 93. Theme tokens централизованы

---

# 94. Random colors/spacing по компонентам запрещены

---

# 95. Global CSS минимален

---

# 96. Feature styles рядом с feature

---

# 97. `!important` не используется как стандартный способ исправления CSS

---

# 98. Z-index policy централизована

---

# 99. Не использовать `9999999`

---

# 100. Layer model explicit

Например:

```text
content
popover
modal
critical overlay
title controls
```

---

# 101. Title controls = top interactive layer

---

# 102. Modal backdrop не блокирует window controls

---

# 103. Focus trap не блокирует window controls

---

# 104. Portal behavior должен соблюдать layer contract

Fluent Dialog/Popover/Tooltip тоже.

---

# 105. Accessibility обязательна

---

# 106. Не использовать `div onClick`, если подходит Button

---

# 107. Inputs имеют label

---

# 108. Icon-only button имеет aria-label

---

# 109. Focus indicator не удаляется без замены

---

# 110. Dialog после закрытия возвращает focus инициатору

---

# 111. Keyboard navigation должна работать

---

# 112. Reduced Motion поддерживается

---

# 113. Animation не должна быть единственным способом показать state

---

# 114. Keyboard shortcuts централизованы

Не создавать независимые key listeners по десяткам компонентов.

---

# 115. Shortcut registry знает active context

Например:

```text
Karaoke
Editor
Dialog
TextInput
```

---

# 116. Input controls имеют приоритет над global shortcuts

---

# 117. Один shortcut не должен одновременно запускать два действия

---

# 118. Loading / Empty / Error / Ready состояния обязательны

---

# 119. Infinite spinner без error path запрещён

---

# 120. Long operation показывает реальный progress/status

---

# 121. Fake progress запрещён

---

# 122. Python offline и AudioService offline — разные состояния

---

# 123. Protocol incompatible — отдельное состояние

---

# 124. Temporary disconnect ≠ incompatible protocol

---

# 125. Error model typed

```ts
interface AppError {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}
```

---

# 126. UI logic использует error code

Не парсить message.

---

# 127. Unknown error имеет fallback

---

# 128. Error Boundary обязателен

---

# 129. Blank screen недопустим

---

# 130. Feature-level Error Boundary допустим для сложных изолированных feature

---

# 131. Toast не используется для critical failure

---

# 132. Critical failure → Dialog/Page state

---

# 133. Не спамить toast'ами

---

# 134. Async race protection обязательна

Например:

```text
Open Song A
↓
Open Song B
↓
response A приходит позже
```

Response A не должен заменить Song B.

---

# 135. Каждый async result проверяет актуальность context

Через:

```text
request id
entity id
revision
generation
abort
```

---

# 136. Stale events должны игнорироваться

---

# 137. Event ordering должен быть определён

Если service выдаёт:

```text
sequence
revision
generationId
```

frontend должен его учитывать.

---

# 138. `AbortController` используется для cancelable requests

Особенно при:

```text
route change
search change
entity switch
component disposal
```

---

# 139. No state update after unmount

Все async callbacks/subscriptions должны корректно завершаться.

---

# 140. StrictMode-safe lifecycle

Effect должен безопасно переживать:

```text
mount
cleanup
mount
```

в development StrictMode.

---

# 141. Subscription должна быть idempotent

---

# 142. `subscribe()` возвращает `unsubscribe()`

---

# 143. Unsubscribe обязателен

---

# 144. No stale closures

Особенно в:

```text
timers
subscriptions
service callbacks
keyboard handlers
```

---

# 145. Не скрывать stale closure неправильным eslint-disable

---

# 146. Retry policy централизована

---

# 147. Не каждый request автоматически retry

---

# 148. GET/read retry допустим по policy

---

# 149. Destructive command retry только при idempotency guarantee

---

# 150. Double-click protection обязательна

Для:

```text
Save
Delete
Start Processing
Record
Import
```

---

# 151. Пока mutation выполняется, повторный submit блокируется либо deduplicated

---

# 152. Request deduplication для одинаковых read queries

---

# 153. Command deduplication через requestId/idempotency where supported

---

# 154. Component unmount не отменяет глобальный backend job автоматически

---

# 155. UI ownership ≠ job ownership

---

# 156. Backend job переживает navigation

---

# 157. Новый screen повторно подписывается на authoritative job state

---

# 158. Local draft отдельно от canonical backend document

---

# 159. Permanent autosave не добавлять без product requirement

---

# 160. Temporary crash draft — отдельная policy, если позже понадобится

---

# 161. Dirty editor close policy explicit

```text
Save
Discard
Cancel
```

---

# 162. Reload/close при dirty state имеет policy

---

# 163. Renderer crash не должен приводить к повреждению backend state

---

# 164. Electron Main не содержит business logic

---

# 165. Preload тоже не содержит business logic

---

# 166. Preload только:

```text
validate
route IPC
map safe result
```

---

# 167. IPC runtime validation обязательна

TypeScript не защищает runtime IPC автоматически.

---

# 168. IPC payload валидируется на обеих сторонах where appropriate

---

# 169. Raw `ipcRenderer` renderer не получает

---

# 170. `contextIsolation = true`

---

# 171. Node integration в renderer off

---

# 172. Content Security Policy обязателен

---

# 173. `eval` запрещён

---

# 174. Unsafe inline scripts запрещены без крайней необходимости

---

# 175. `dangerouslySetInnerHTML` запрещён по умолчанию

---

# 176. External rich HTML sanitizes, если когда-нибудь появится

---

# 177. External URL open policy

`openExternal` принимает только разрешённые protocols/domains according to policy.

---

# 178. `javascript:` и подобные unsafe protocols запрещены

---

# 179. Custom Electron protocol защищён

Нельзя получить arbitrary filesystem file через crafted URL.

---

# 180. Path traversal запрещён

---

# 181. Renderer не формирует arbitrary local path для custom protocol

---

# 182. Object URLs очищаются

```text
URL.createObjectURL
→
URL.revokeObjectURL
```

---

# 183. Image/video failure isolated

Broken cover/video не ломает весь screen.

---

# 184. Media fallback defined

---

# 185. Media preload имеет budget

---

# 186. Не загружать десятки heavy videos заранее

---

# 187. Covers lazy-loaded where useful

---

# 188. Large list virtualization state продуман

---

# 189. Virtualized unmount не должен терять critical selection state

---

# 190. Context menu / selection state не хранить исключительно внутри размонтируемой card

---

# 191. List keys stable

```text
songId
recordingId
participantId
```

---

# 192. Array index как key запрещён для mutable lists

---

# 193. Responsive minimum window size определён

---

# 194. UI должен корректно деградировать при минимальном размере окна

---

# 195. Windows DPI scaling учитывать

Минимум:

```text
100%
125%
150%
200%
```

---

# 196. Не позиционировать UI исходя из фиксированных физических pixels экрана

---

# 197. Multi-monitor behavior не должен зависеть от React assumptions

Window restore/screens belong to Electron.

---

# 198. Long text policy едина

Для:

```text
title
artist
filename
participant name
```

определить:

```text
wrap / ellipsis / tooltip
```

---

# 199. Localization expansion учитывать

UI не проектируется только под длину английских строк.

---

# 200. Все пользовательские строки централизованы

---

# 201. Не писать literal UI strings случайно в компонентах

---

# 202. Capability gating обязательна

UI action отображается/активируется по:

```text
capabilities
permissions
state
```

а не через «попробуем и увидим ошибку».

---

# 203. Unsupported feature не должна выглядеть доступной

---

# 204. Protocol incompatibility блокирует соответствующую capability

---

# 205. Offline/reconnect UX explicit

Различать:

```text
connecting
connected
reconnecting
offline
incompatible
failed
```

---

# 206. Reconnect centralized

---

# 207. Не писать reconnect logic в каждом hook

---

# 208. После reconnect получить authoritative snapshot заново

---

# 209. Старый snapshot не считается valid после reconnect

---

# 210. Service restart invalidates stale runtime assumptions

---

# 211. Playback generationId учитывается

---

# 212. Room revision учитывается

---

# 213. Editor expectedRevision учитывается

---

# 214. Не принимать stale async event просто потому, что он «последний пришёл»

---

# 215. Performance budget задаётся

Для ключевых экранов:

```text
Library scrolling
Karaoke animation
Editor dragging
Startup
```

---

# 216. Karaoke/render target

Стремиться к стабильному:

```text
60 FPS
```

где hardware позволяет.

---

# 217. UI interaction не должна блокироваться heavy calculation

---

# 218. React profiling использовать перед сложной оптимизацией

---

# 219. `useMemo` не использовать автоматически

---

# 220. `useCallback` не использовать автоматически

---

# 221. `React.memo` не использовать автоматически

---

# 222. Сначала правильная state boundary

---

# 223. Потом profiling

---

# 224. Потом memoization

---

# 225. Bundle budget существует

Новая dependency оценивается по:

```text
bundle size
maintenance
security
value
```

---

# 226. Не добавлять библиотеку ради 10 строк простого кода

---

# 227. Не добавлять две библиотеки для одной задачи

---

# 228. Heavy routes lazy-load

Например:

```text
Melody Editor
Room
Diagnostics
```

если это даёт реальную пользу.

---

# 229. Не lazy-load каждый маленький component

---

# 230. Startup critical path должен оставаться маленьким

---

# 231. Lazy import имеет error fallback

---

# 232. Heavy visualizer изолирован

---

# 233. WebGL/canvas engine не живёт на 700 строк внутри React component

---

# 234. React component управляет lifecycle visualizer

---

# 235. Rendering engine отдельно

---

# 236. Worker использовать только для frontend-heavy computation

Не дублировать Python/AudioService responsibilities.

---

# 237. Worker lifecycle explicit

---

# 238. Worker закрывается

---

# 239. Timers имеют owner

---

# 240. Каждый timer cleanup

---

# 241. Никаких unmanaged subscriptions

---

# 242. Никаких unmanaged event listeners

---

# 243. `exhaustive-deps` не отключается глобально

---

# 244. Если effect loop — исправить design

---

# 245. Global event emitter не основной communication mechanism

---

# 246. Direct typed call/subscription предпочтительнее

---

# 247. Event bus только при реальном many-to-many use-case

---

# 248. Events typed

---

# 249. Event names centralized

---

# 250. Storage frontend ограничен

---

# 251. `localStorage` не является базой данных

---

# 252. UI preferences можно хранить локально по policy

---

# 253. Persistent product state принадлежит Python

---

# 254. Live audio state принадлежит AudioService

---

# 255. Window state принадлежит Electron Main

---

# 256. Random `localStorage.setItem()` в components запрещён

---

# 257. Frontend persistence adapter централизован

---

# 258. Persisted frontend keys versioned where needed

---

# 259. Search/filter ownership определяется заранее

---

# 260. Если search backend-authoritative — frontend не реализует отличающийся алгоритм поиска

---

# 261. Local filtering допустим только для loaded dataset и ясной semantics

---

# 262. Pagination и virtualization должны работать согласованно

---

# 263. Не смешивать server pagination с assumption «все данные уже в памяти»

---

# 264. Data normalization в client/mapper layer

---

# 265. Component не чинит API response вручную

---

# 266. Invalid DTO → contract error

---

# 267. DTO → ViewModel mapper создаётся только если реально нужен

---

# 268. Не создавать mapper ради mapper

---

# 269. Simplicity > abstraction

---

# 270. Explicit JSX > clever meta-rendering

---

# 271. Не создавать UniversalFormBuilder без требования

---

# 272. Не создавать UniversalTable без реальной устойчивой модели

---

# 273. Не строить JSON-driven UI без product requirement

---

# 274. DRY без фанатизма

---

# 275. Semantic duplication нужно устранять

---

# 276. Visual duplication можно оставить, если abstraction ухудшит понимание

---

# 277. Feature dependencies направлены

Пример:

```text
shared
↑
entities
↑
features
↑
pages/app
```

---

# 278. `shared` не импортирует `features`

---

# 279. `entities` не импортируют `pages`

---

# 280. `features` не импортируют app internals

---

# 281. Circular imports запрещены

---

# 282. Local import не лечит architecture cycle

---

# 283. Barrel files маленькие

---

# 284. Giant re-export `index.ts` запрещён

---

# 285. Feature public API минимален

---

# 286. Internal feature files не импортируются извне, если есть public boundary

---

# 287. Import-time side effects запрещены

Импорт module не:

```text
connects service
starts timer
opens IPC
mutates storage
```

---

# 288. Bootstrap централизован

---

# 289. Service clients создаются один раз в composition root

---

# 290. Components не создают PythonClient

---

# 291. Components не создают AudioServiceClient

---

# 292. DI простой

---

# 293. Не создавать frontend DI framework без причины

---

# 294. Production `.js/.jsx` → `.ts/.tsx` replacement полная

---

# 295. Нельзя оставлять рядом:

```text
Component.jsx
Component.tsx
```

---

# 296. Нельзя оставлять:

```text
api.js
api.ts
```

---

# 297. Новая implementation полностью заменяет старую

---

# 298. При замене component удалить:

```text
old component
old styles
old hooks
old tests
old route if obsolete
```

---

# 299. При замене API client удалить:

```text
old client
duplicate DTO
old protocol mappings
```

---

# 300. `V2`, `New`, `Final`, `Legacy` как permanent naming запрещены

---

# 301. Git = история

---

# 302. Temporary migration path имеет:

```text
owner
reason
removal condition
```

---

# 303. Deprecated component имеет removal plan

---

# 304. Feature flag временный

---

# 305. После rollout old branch удаляется

---

# 306. Feature cleanup contract

При удалении feature удалить:

```text
route
components
hooks
styles
translations
tests
assets
client methods
feature flags
dependencies
```

---

# 307. Dead component удаляется

---

# 308. Dead hook удаляется

---

# 309. Dead CSS удаляется

---

# 310. Dead DTO удаляется

---

# 311. Dead IPC command удаляется

---

# 312. Dead dependency удаляется

---

# 313. Commented-out JSX запрещён

---

# 314. `TODO maybe later` запрещён

---

# 315. Feature Complete = Cleanup Complete

---

# 316. Architecture CI обязателен

Проверять:

```text
forbidden imports
cycles
production JS/JSX
oversized modules
unused exports
unused dependencies
duplicate protocol definitions
```

---

# 317. File size warning

```text
>300 lines
→ warning
```

---

# 318. >500 handwritten production lines

```text
→ failure or explicit allowlist
```

---

# 319. Complexity warning для giant hooks/functions

---

# 320. Fan-out warning

Модуль, импортирующий слишком много независимых subsystems, проверяется на God Object.

---

# 321. Architecture allowlist минимален

---

# 322. CI должен проверять TS cycles

---

# 323. CI должен находить unused dependencies

---

# 324. CI должен находить unused exports where practical

---

# 325. CI должен запрещать duplicate component implementation patterns where configured

---

# 326. Refactor должен уменьшать mental complexity

---

# 327. Если refactor добавил:

```text
больше wrappers
больше providers
больше generic types
больше indirection
```

без улучшения понимания — refactor плохой.

---

# 328. Не использовать pattern/library ради моды

---

# 329. Redux/Zustand/XState/query library выбирается только под конкретную проблему

---

# 330. Простая state не требует state-machine library

---

# 331. Сложный lifecycle может использовать state-machine library, если это реально упрощает систему

---

# 332. Query library может владеть remote cache

---

# 333. Не создавать manual duplicate cache поверх неё

---

# 334. Forms library использовать для сложных forms

---

# 335. Простой form не требует framework

---

# 336. Architecture review перед feature

До кода ответить:

```text
Кто владеет данными?
Что хранит React?
Что persistent?
Что external?
Что переживает reload?
Какие states?
Какие races?
Что при service restart?
Что при disconnect?
Что при duplicate click?
Что при cancel?
```

---

# 337. После этого определить state model

---

# 338. Потом service contract

---

# 339. Потом component composition

---

# 340. Потом failure/reconnect behavior

---

# 341. Потом implementation

---

# 342. Не начинать с «давайте сделаем компонент»

---

# 343. Definition of Done для frontend feature

Должны быть определены:

```text
owner
source of truth
loading
empty
error
ready
service contract
async races
cleanup
reconnect
accessibility
performance
tests
```

---

# 344. Для form feature дополнительно:

```text
loaded
draft
dirty
validation
save
discard
conflict
```

---

# 345. Для realtime feature:

```text
snapshot rate
stale events
generation
service restart
disconnect
reconnect
```

---

# 346. Для long operation:

```text
pending
progress
cancel
timeout
failure
retry
reconnect
```

---

# 347. Code Review Checklist

Перед merge проверить:

```text
Можно ли сделать проще?

Есть ли второй Source of Truth?

Не появился ли God Component?

Не появился ли God Hook?

Не появился ли God Context/Store?

Нет ли лишнего useEffect?

Можно ли derived state вычислить?

Есть ли stale async protection?

Есть ли AbortController где нужен?

Нет ли duplicate request?

Нет ли double-submit?

Есть ли cleanup subscription/timer?

StrictMode-safe ли lifecycle?

Нет ли raw fetch?

Нет ли raw IPC?

Нет ли any?

Runtime boundary валидируется?

Есть ли loading/empty/error state?

Accessibility учтена?

CSP/security boundary не нарушена?

Old implementation удалена?

Dead styles/tests/dependencies удалены?
```

---

# 348. Главное правило Component

```text
COMPONENT
=
PRESENTATION
+
MINIMAL INTERACTION
```

---

# 349. Главное правило Feature

```text
FEATURE
=
ONE USER CAPABILITY
```

---

# 350. Главное правило State

```text
ONE FACT
=
ONE AUTHORITATIVE OWNER
```

---

# 351. Главное правило Effects

```text
NO EFFECT
IF PURE CALCULATION IS ENOUGH
```

---

# 352. Главное правило Context

```text
CONTEXT
IS NOT
A GLOBAL DATABASE
```

---

# 353. Главное правило TypeScript

```text
TYPE SYSTEM
IS PART OF ARCHITECTURE
```

---

# 354. Главное правило async

```text
ASYNC RESULT
MUST PROVE
THAT IT IS STILL RELEVANT
```

---

# 355. Главное правило service events

```text
STALE EVENT
MUST NEVER
OVERWRITE NEW STATE
```

---

# 356. Главное правило Security

```text
RENDERER
IS AN UNTRUSTED BOUNDARY
```

---

# 357. Главное правило external state

```text
PYTHON / AUDIOSERVICE STATE
IS NOT REIMPLEMENTED IN REACT
```

---

# 358. Главное правило Refactor

```text
REPLACEMENT
=
NEW IMPLEMENTATION
+
OLD IMPLEMENTATION DELETED
```

---

# 359. Главное правило Dependencies

```text
DEPENDENCY
MUST SOLVE
A REAL PROBLEM
```

---

# 360. Главное правило роста

Frontend растёт:

```text
ПО FEATURES
```

а не:

```text
одним App
одним Context
одним Store
одним Hook
одной Page
```

---

# 361. Идеальная эволюция

```text
новая capability
↓
определён owner
↓
typed contract
↓
feature boundary
↓
маленькие components
↓
tests
```

---

# 362. Плохая эволюция

```text
новая функция
↓
+200 строк в Page
↓
+8 useState
↓
+5 useEffect
↓
+12 props
↓
+ещё один Context
```

---

# 363. Финальный принцип

```text
FRONTEND
=
ТОНКОЕ,
ТИПИЗИРОВАННОЕ,
ПРЕДСКАЗУЕМОЕ ПРЕДСТАВЛЕНИЕ
НАД ГОТОВЫМИ SYSTEM CAPABILITIES
```

Он не должен повторно реализовывать Python Backend или AudioService.

---

# 364. Статус

```text
FRONTEND ARCHITECTURE RULES
=
LOCKED
```

Новые общие правила добавляются только при появлении нового реального класса архитектурной проблемы.

Не расширять архитектуру speculative-ограничениями «на будущее».
