# Frontend technology contract

## 1. Канонический стек

Frontend A&D Voice создаётся с нуля на следующем стеке:

```text
React
TypeScript
Electron
Vite
Theme UI kit (src/theme/ui)
Formik
lucide-react
```

Для production frontend application code используются только `.ts` и `.tsx`.

JavaScript (`.js` / `.jsx`) не является языком нового application layer. Он допустим только для стороннего/vendor-кода, generated output или инструментов, которые технически требуют JavaScript и не входят в application logic.

## 2. Почему TypeScript обязателен

Frontend одновременно работает с несколькими строгими внешними контрактами:

```text
Python Backend API
AudioService IPC
Electron Preload API
project/editor DTO
room-control state
runtime audio snapshots
```

Поэтому типы являются частью системного контракта, а не дополнительной документацией.

TypeScript должен ловить до запуска приложения как минимум:

- несовместимые DTO;
- неизвестные state values;
- неправильные command payload;
- отсутствие обязательных полей;
- неверное использование optional/null states;
- несовместимость result/error contracts;
- нарушения exhaustive state handling.

## 3. TypeScript mode

Проект работает в strict TypeScript mode.

Минимальный baseline:

```text
strict = true
noImplicitAny = true
strictNullChecks = true
noUncheckedIndexedAccess = true
noImplicitOverride = true
useUnknownInCatchVariables = true
```

Дополнительные compiler flags могут усиливаться, но не ослаблять эти гарантии без конкретной причины.

## 4. `any` не является штатным типом

Production application code не использует `any` как способ обойти типизацию.

На недоверенной внешней границе используется:

```text
unknown
→ runtime validation / decoder
→ typed DTO
```

`any` допустим только в generated/vendor boundary, где это объективно невозможно исправить локально.

## 5. Контракты Python Backend

Python Backend считается готовой отдельной системой.

Frontend знает только его публичный API contract.

Он не должен знать:

```text
Python module names
SQLAlchemy models
filesystem implementation
AI provider implementation
internal processing classes
```

Frontend работает с typed contracts, например:

```text
SongDto
ProcessingJobDto
ProjectDto
EditorDocumentDto
RecordingDto
AnalysisDto
ModelDto
CapabilitiesDto
BackendHealthDto
RoomStateDto
```

Если Python публикует OpenAPI, допускается generation транспортных DTO/client primitives из OpenAPI. Generated code не редактируется вручную.

## 6. Контракты AudioService

AudioService считается готовым realtime media engine.

Frontend знает только его versioned public protocol.

Typed command/event contracts покрывают:

```text
service lifecycle
runtime configuration
devices
playback
transport
mixer
monitoring
recording
editor preview
radio
room media
live levels
diagnostics
recovery
```

Renderer не работает с raw named-pipe messages или raw transport frames.

## 7. Electron boundary

Renderer не имеет прямого Node.js/OS/native access.

Разрешён только узкий typed API, предоставленный preload.

Например:

```text
window controls
file picker
folder picker
reveal/open folder
clipboard/native desktop actions
service command bridge
application lifecycle notifications
```

`contextIsolation` сохраняется включённым, а unrestricted Node integration renderer не получает.

## 8. React responsibility

React отвечает только за:

```text
presentation
user interaction
local UI draft state
view composition
visual interpolation
accessibility
theme/i18n
```

React не становится вторым backend, process supervisor или audio engine.

## 9. State ownership

Каждый state имеет одного authoritative owner:

```text
Library / projects / processing / history / models / room control
→ Python Backend

Playback / devices / mixer / monitoring / recording / remote media / live diagnostics
→ AudioService

Window / native desktop execution
→ Electron Main

Modal / selected tab / hover / unsaved form draft
→ React
```

React может кэшировать snapshot для UI, но не создаёт конкурентный authoritative state.

## 10. Remote state после reconnect

После reconnect/restart frontend повторно получает authoritative snapshot соответствующей системы.

Старый renderer cache не считается истинным после разрыва соединения.

## 11. State machines

Закрытые lifecycle states описываются discriminated unions или enum-like literal contracts.

Пример:

```ts
export type KaraokeState =
  | { kind: "preparing" }
  | { kind: "ready" }
  | { kind: "playing"; positionSeconds: number }
  | { kind: "paused"; positionSeconds: number }
  | { kind: "stopping" }
  | { kind: "finished" }
  | { kind: "failed"; error: AppError };
```

Обработка state должна быть exhaustive.

## 12. Не использовать boolean soup

Нельзя представлять один lifecycle множеством независимых flags:

```text
isPlaying
isPaused
isLoading
isFailed
isFinished
```

если эти значения являются одним закрытым состоянием.

Используется один state model.

## 13. API clients

Каждая внешняя система имеет отдельный client boundary:

```text
PythonClient
AudioServiceClient
DesktopClient
```

Внутри Python client допускаются domain-specific clients:

```text
SongsApi
ProcessingApi
EditorApi
RecordingsApi
ModelsApi
RoomApi
DiagnosticsApi
```

UI components не вызывают `fetch`, raw IPC или preload primitives напрямую.

## 14. Transport details не протекают в UI

Component не должен знать:

```text
HTTP URL construction
IPC channel string
named-pipe framing
retry protocol
serialization detail
```

Он вызывает typed application action/client method.

## 15. Runtime validation

TypeScript не заменяет runtime validation внешних данных.

Данные, пришедшие через недоверенную/несовместимую boundary, проверяются до попадания в application state, когда transport contract не гарантирует их корректность автоматически.

## 16. Error contract

Frontend использует typed application error:

```text
code
message
details
source
requestId / correlationId when available
```

UI branching выполняется по стабильному `code`, а не по парсингу текста `message`.

## 17. No duplicate domain logic

Frontend может выполнять только presentation validation и immediate UX checks.

Canonical business validation остаётся владельцу domain.

Например editor UI может не позволить визуально вытянуть ноту за слово, но Python всё равно проверяет canonical document при Save.

## 18. Data fetching

Remote state fetching, refresh, cancellation и reconnect должны быть централизованы на feature/client boundary.

Нельзя размножать одинаковый `useEffect + fetch + loading + error` boilerplate по страницам.

При этом не вводится универсальный data framework только ради нескольких запросов: выбирается минимальный устойчивый механизм, соответствующий реальным потребностям проекта.

## 19. Long-running operations

Frontend не симулирует progress длинной операции.

Он отображает authoritative:

```text
state
stage
progress
error
```

из Python Backend или AudioService.

## 20. Playback timeline

Authoritative Karaoke/preview position приходит от AudioService.

Frontend может интерполировать между snapshots только для плавности визуализации.

Интерполяция никогда не становится новым source of truth.

## 21. Visualizer

Visualizer относится к presentation layer.

Он может использовать Worker/WebGL для тяжёлой визуальной работы, но не получает ответственность за audio capture, playback, mixer или DSP.

Вход visualizer — bounded telemetry/features, предоставленные realtime/media layer по определённому контракту.

## 22. Theme UI kit и формы

Базовой UI-system является собственный **Theme UI kit** проекта (`src/theme/ui`): Button, IconButton, TextField, NumberField, Select, Switch, Slider, RotaryKnob, Tabs, Modal, Popover, Tooltip, Progress, Card, Grid, Stack, Typography, FolderField и другие. Цвета, отступы, радиусы, тени и z-index приходят из его tokens и palettes (`:root[data-theme]`); размеры задаются viewport-relative токенами, чтобы интерфейс масштабировался под любой экран.

Сначала использовать подходящий компонент kit.

Custom component создаётся, когда:

- нужной product-композиции нет в kit;
- требуется reusable product-specific component;
- custom rendering является частью Karaoke/Editor/visualizer.

Не переписывать стандартный Button/Modal/Select/Input вручную без причины.

**Формы.** Все формы приложения (настройки, добавление песни, настройки песни, онлайн-комната, переименование дубля) строятся через kit `GetForm` / `RenderFormikFields` поверх Formik: поля описываются массивом типизированных строк (`tag`, `type`, `label`, `options`, `onSave`, `showFor`, адаптивные `xs/sm/md/lg/xl`), значения читаются и пишутся по пути (`audio.rate`). Свои контролы подключаются через `components`. Formik используется вместо самописного form engine; схемные библиотеки не подключаются, валидация задаётся функциями `validate`.

**Backdrop.** Фон всего приложения — картинка текущей темы с анимацией Quantum Fields (`three`, лицензия MIT), рисуемой изолированным runtime в iframe; движок не конкурирует с React, а данные о звуке приходят из AudioService (см. Addendum A).

## 23. Lucide

`lucide-react` используется для product iconography согласно `Frontend-content-catalog.md`.

Не копировать Lucide SVG вручную в repository.

## 24. Styling

Визуальная система использует единые design tokens.

Нельзя размножать случайные magic colors, radii, shadows, z-index и spacing по feature code.

Product-specific values оформляются semantic tokens.

## 25. Accessibility

Interactive controls используют semantic HTML и semantics Theme UI kit.

Обязательны:

```text
keyboard navigation
visible focus
accessible names
correct disabled state
reduced motion support
contrast-aware states
```

## 26. Localization

UI text не размазывается hardcoded-строками по components.

Поддерживаемые product languages:

```text
Ukrainian
Russian
English
```

## 27. Vite

Vite используется как frontend build/dev tooling.

Environment/config boundary должна быть typed и централизованной. Components не читают произвольные `import.meta.env` keys напрямую.

## 28. Testing stack

Frontend testing baseline:

```text
Vitest
React Testing Library
Playwright
```

Unit/component tests проверяют behavior, а Playwright — небольшое количество ключевых end-to-end desktop/user flows.

## 29. Production JavaScript policy

Новый frontend не создаёт параллельные `.js/.jsx` implementation рядом с `.ts/.tsx`.

Запрещено конечное состояние:

```text
SongCard.jsx
SongCardV2.tsx
```

Canonical implementation одна и написана на TypeScript.

## 30. Итог

Канонический frontend stack:

```text
React + TypeScript + Electron + Vite + Theme UI kit (`src/theme/ui`) + Formik
```

TypeScript выбран не ради количества типов, а для того, чтобы внешние контракты Python Backend, AudioService и Electron были проверяемыми и exhaustive ещё до runtime.
