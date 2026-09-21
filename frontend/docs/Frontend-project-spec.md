# Полное описание frontend-проекта A&D Voice с нуля

## 0. Назначение frontend

Frontend A&D Voice — это desktop-интерфейс karaoke-приложения для Windows. Он отвечает за взаимодействие пользователя с библиотекой песен, запуск karaoke-сессии, отображение текста и нот, управление playback, microphone/room controls, работу с online room, melody editor, настройками приложения, историей, диагностикой и системными возможностями Electron.

Frontend не является realtime audio engine. Live audio обслуживается отдельным `AudioService.exe`. Offline обработка песен, AI, библиотечные данные, история и проектные файлы обслуживаются Python backend.

Целевая схема продукта:

```text
React UI
   ↓
Electron Main / Preload
   ├── Python Backend
   │     ├── Library
   │     ├── Song processing
   │     ├── AI / ML
   │     ├── SQLite / History
   │     └── Project files
   │
   └── AudioService.exe
         ├── Playback
         ├── Monitoring
         ├── Recording
         ├── Mixer / DSP
         ├── Room media
         └── Audio diagnostics
```


---

# 0.0.1. Зафиксированный frontend stack

Новый frontend создаётся на:

```text
React
TypeScript
Electron
Vite
Theme UI kit (src/theme/ui)
Formik
lucide-react
```

Production application logic использует `.ts` / `.tsx`. JavaScript не является альтернативным application path. Python Backend и `AudioService.exe` на момент разработки frontend считаются готовыми самостоятельными системами; frontend интегрируется только с их публичными typed/versioned contracts. Подробный нормативный contract находится в `Frontend-technology-contract.md`.

TypeScript работает в strict mode. `any` не используется как способ обхода contract typing; недоверенные внешние данные входят как `unknown` и преобразуются в typed DTO на boundary.

# 0.1. Каноническая граница систем

A&D Voice проектируется с нуля как одно desktop-приложение, но четыре части продукта имеют разные обязанности и не дублируют друг друга.

```text
React Renderer
= UI / presentation / user interaction only

Electron Main + Preload
= desktop / OS / process bridge

Python Backend
= offline processing / AI / data / library / persistence / room control

AudioService.exe
= all live audio / realtime media
```

Пользователь видит одно приложение, но исполнение функции всегда принадлежит одному владельцу. Frontend не создаёт вторую реализацию функций Python, Electron Main или AudioService.

Полная схема:

```text
                         React Renderer
                              │
                UI state / commands / views
                              │
                         Preload API
                              │
                         Electron Main
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
          Python Backend             AudioService.exe
                 │                         │
      Offline / Data / AI              Live Audio
                 │                         │
                 └────────────┬────────────┘
                              │
                       One desktop product
```

---

# 0.2. Что принадлежит React Renderer

React Renderer отвечает только за пользовательский интерфейс и presentation logic:

```text
Routes and screens
Layout
Library cards/grid
Search/filter/sort UI
Forms
Dialogs
Transient notifications
Settings presentation
Lyrics rendering
Piano-roll rendering
Live pitch visualization
Melody Editor interactions
Room participant presentation
Progress/status presentation
Theme and localization presentation
Accessibility
Keyboard interaction
```

React может временно хранить только UI-state, например:

```text
opened modal
selected tab
hover/focus
local form draft
editor selection
scroll position
visual display mode
```

React не является authoritative owner для long-running processing, audio session, device state, recording execution, room media, filesystem или native process lifecycle.

---

# 0.3. Что принадлежит Electron Main / Preload

Electron Main является единственным desktop/system bridge. Он исполняет:

```text
Create/manage desktop window
Minimize / maximize / restore / close
Fullscreen
Multi-monitor/window placement
Launch/monitor/stop AudioService.exe
Launch/monitor/stop Python backend where product packaging requires it
Named-pipe/native IPC connection
File picker
Folder picker
Reveal/Open folder in Explorer
Safe local file access required by desktop UI
Open Windows Settings / external system pages
Clipboard/native desktop operations
Keyboard lighting / Windows-specific native integration bridge
App update/restart bridge when updates are introduced
```

Renderer получает только узкий preload API. Он не получает Node.js process handles, filesystem APIs, named-pipe handles, COM objects или unrestricted OS access.

---

# 0.4. Что принадлежит Python Backend

Python Backend является authoritative owner для offline/data domain:

```text
Song library
Song metadata
SQLite/data persistence
Song import registration
Offline processing pipeline
Offline AI / ML processing
Lyrics/project generation
Song processing queue and status
Project validation/version information
Melody Editor project document persistence
Recording metadata/history after AudioService creates the audio file
Performance analysis results
History
Storage/cache metadata and cleanup operations
AI model status/download management
Room creation/join/control/signaling/auth/session metadata
Backend/about version information
```

Python Backend не участвует в live PCM path. Он не захватывает микрофон, не делает monitoring, не микширует live audio, не рендерит remote voices и не является playback clock karaoke session.

---

# 0.5. Что принадлежит AudioService.exe

AudioService является единственным владельцем live/realtime audio domain:

```text
Audio device discovery
WASAPI Shared / Exclusive
ASIO
Runtime audio configuration
Microphone capture
Song/music playback
Play / Pause / Seek
Authoritative session/playback clock
Monitoring
Mixer
Live DSP/effects
Live resampling/format conversion
Recording realtime path and audio-file writing
Remote voice encode/decode/media path
Network jitter buffer
RemoteVoiceSource playback
Clock synchronization / drift correction
Output routing
Realtime latency/runtime diagnostics
Audio recovery/reconfiguration
Radio audio playback
Editor audio preview
```

Ни React, ни Python не создают параллельный live audio path.

---

# 0.6. Authoritative state ownership

Каждый тип состояния имеет одного владельца:

```text
Library / processing / project state
→ Python Backend

Audio devices / runtime configuration / playback / recording / mixer / live room media
→ AudioService.exe

Window/process/native desktop state
→ Electron Main

Pure presentation state
→ React Renderer
```

После reconnect/restart React всегда повторно получает authoritative snapshot от соответствующего владельца и не продолжает считать старый renderer state истинным.

---

# 0.7. Что намеренно отсутствует во frontend renderer

В целевом проекте React Renderer **не содержит**:

```text
AudioContext as the main audio engine
getUserMedia microphone capture for karaoke monitoring
MediaStream-based local monitoring
PCM processing
Realtime recording implementation
Remote PCM decoder/playback
Network jitter-buffer logic
Audio-device enumeration through browser APIs
Sample-rate conversion
Realtime DSP
Authoritative playback timer
Direct filesystem access
Direct child-process management
Direct named-pipe/native IPC implementation
Direct Windows COM/Win32 integration
Long-running song processing implementation
```

Видео остаётся browser/Electron visual media, но его audio track всегда muted/disabled; authoritative audio playback выполняет AudioService.


# 1. Основные пользовательские зоны

Приложение состоит из трёх основных полноэкранных рабочих зон:

```text
Library
Karaoke
Melody Editor
```

и одного глобального overlay-раздела:

```text
Settings
```

Дополнительно поверх основных зон могут отображаться:

```text
Online Room Dock
Dialogs
Processing Modal
Recordings Modal
Song Settings Modal
Performance Analysis Modal
Global transition blackout
```

---

# 2. Основная навигация

Маршруты продукта:

```text
/                  → Library
/karaoke/:songId   → Karaoke
/editor/:songId    → Melody Editor
```

Неизвестный маршрут возвращает пользователя в Library.

Settings не является отдельным route. Он открывается поверх текущей рабочей зоны как modal surface. При этом системные кнопки title bar остаются выше Settings и всегда доступны.

---

# 3. Запуск приложения

После запуска Electron frontend проходит четыре видимых стадии:

```text
Desktop window created
↓
Backend / runtime bootstrap
↓
Global contexts available
↓
Current route rendered
```

Пользователь не должен видеть partially initialized интерфейс, в котором кнопки доступны раньше необходимых сервисов.

При критической ошибке bootstrap показывается понятное error state вместо пустого окна.

---

# 4. Global App Shell

Верхний уровень интерфейса называется App Shell.

Он содержит:

```text
Title Bar
Main Route Surface
Global Floating Controls
Settings Modal
Online Room Dock
Global Dialog Layer
Global Transition Blackout
```

Фон shell использует текущую theme palette и не должен добавлять отдельный чёрный слой поверх Library/Karaoke backgrounds без функциональной необходимости.

---

# 5. Desktop Title Bar

Окно использует собственный title bar, который является **самым верхним интерактивным слоем всего приложения**.

В правой части размещаются три действия:

```text
Minus       → Minimize
Maximize2   → Maximize / Restore
X           → Close
```

Использовать Lucide-объекты:

- `Minus`
- `Maximize2`
- `X`

Кнопки title bar должны всегда находиться **поверх всех страниц, overlay, popover, dropdown, Settings, dialogs, processing surfaces, room dock, transition blackout и любых modal surfaces**. Никакая модалка или overlay не может перекрыть, затемнить до некликабельного состояния или перехватить pointer events этих кнопок. Пользователь всегда может свернуть, развернуть/восстановить или закрыть приложение.

Title bar **полностью прозрачный**: у него нет ни фона, ни рамки, ни размытия, и в нём **нет текста** (название приложения не выводится). Виден только блок из трёх кнопок справа, а картинка приложения проходит под ним. Кнопки остаются доступны на Library, Karaoke, Melody Editor и поверх любых глобальных modal states.

Зона title bar вне системных кнопок работает как Electron drag-region. Все интерактивные элементы title bar и области под ними должны быть исключены из drag-region через `no-drag`.

---

# 6. Global Floating Controls

На Library отображается небольшая floating control group в правом нижнем углу.

Содержит:

```text
Radio
Settings
```

Для Radio использовать:

- `Radio`
- `Volume2`

Для Settings:

- `Cog`

Если radio включено, hover/focus на radio control открывает компактный volume popover.

В Karaoke и Melody Editor этот floating block не показывается, потому что обе зоны имеют собственные controls.

---

# 7. Visual themes

Приложение поддерживает четыре theme presets:

```text
dark
light
green
violet
```

Preview assets:

```text
assets/theme-icons/dark.png
assets/theme-icons/light.png
assets/theme-icons/green.png
assets/theme-icons/violet.png
```

Каждая тема задаёт:

```text
background
surface colors
text colors
primary/secondary accent
borders
focus color
gradients
karaoke scene appearance
```

Смена темы должна сразу отражаться во всех текущих поверхностях без перезапуска приложения.

---

# 8. Global dialogs

Приложение имеет общий dialog layer для:

```text
Alert
Confirmation
Critical warning
```

Для warning использовать `AlertTriangle`, для информационного состояния `Info`.

Dialogs должны быть доступны поверх любого route и поверх Settings.

---

# 9. Library — назначение

Library является домашним экраном приложения.

Главная задача Library:

```text
увидеть музыкальную библиотеку
↓
найти песню
↓
понять её готовность
↓
запустить karaoke
```

Дополнительные действия:

```text
import song
process/reprocess song
open recordings
open song settings
open melody editor
open folder
remove song
create/join online room
inspect processing queue
```

---

# 10. Library background

Library использует интерактивный `QuantumFieldBackdrop`.

Это программный animated background, а не обычная bitmap-картинка.

Он должен создавать premium ambient scene и оставаться визуально вторичным по отношению к карточкам и hero content.

При активной тяжёлой processing surface фон может быть отключён, чтобы не конкурировать с foreground state.

Лицензионный файл для QFT-материала находится:

```text
assets/licenses/LICENSE-QFT.txt
```

---

# 11. Library Hero

Верхняя зона Library должна сразу отвечать на вопросы:

```text
Что это за библиотека?
Сколько песен доступно?
Сколько готово к karaoke?
Как быстро найти/добавить песню?
Есть ли active online room?
```

Hero включает:

```text
Название / visual identity
Song count
Ready count
Search
Filters
Add Song
Online Room
```

Использовать иконки:

- `Music2`
- `Mic2`
- `Sparkles`
- `Plus`
- `Search`
- `SlidersHorizontal`
- `UsersRound`
- `Headphones` при related recording action

---

# 12. Library search

Search field фильтрует библиотеку по пользовательскому запросу.

Поиск должен работать по понятным song metadata:

```text
Title
Artist
Genre
```

Пустой search показывает весь набор, ограниченный активными filters.

Использовать объект `Search`.

---

# 13. Library filters

Filter panel вызывается через `SlidersHorizontal`.

Фильтры могут включать доступные метаданные библиотеки, например:

```text
status
artist
genre
difficulty
other backend-supported values
```

UI фильтров не должен занимать постоянное большое пространство, если пользователь его не открыл.

---

# 14. Song Grid

Основная библиотека отображается сеткой song cards.

Card должна позволять определить без открытия отдельного экрана:

```text
song title
artist
artwork/fallback
status
processing state
availability for karaoke
```

Grid адаптируется к размеру окна.

---

# 15. Song Cover Art

Если у песни есть artwork, используется оно.

Если artwork отсутствует, применяется visual fallback с Lucide `Music2`.

Fallback не должен выглядеть как broken image placeholder.

---

# 16. Song Card — готовая песня

Для `ready/done` песни основное действие:

```text
Play Karaoke
```

Использовать `Play`.

Дополнительные действия:

```text
Headphones  → recordings
Settings2   → song settings
FolderOpen  → song folder
Trash2      → delete
Ellipsis    → secondary actions
```

---

# 17. Song Card — необработанная песня

Если karaoke artifacts ещё не готовы, primary action меняется на обработку.

Использовать:

```text
AudioWaveform → Process Song
```

После ранее выполненной обработки должна быть доступна explicit reprocess action:

```text
RotateCcw → Reprocess
```

---

# 18. Song states

Song card должна визуально различать минимум:

```text
not processed
queued
processing
ready
failed
transferring/importing
```

Состояние должно быть понятно без чтения backend logs.

---

# 19. Add Song Modal

Открывается через `Plus`.

Назначение:

```text
выбрать audio file
↓
показать выбранный файл
↓
подтвердить import
```

Использовать `Music2` как основную визуальную метафору песни.

Если файл можно preview, доступны:

- `Play`
- `Pause`

Frontend не обязан сам выполнять AI processing. Он запускает backend operation и отображает её статус.

---

# 20. Processing Modal

Processing Modal показывает обработку одной или нескольких песен.

Основные состояния:

```text
Queue
Processing
Completed
Failed
```

Использовать:

- `CircleDot` — queued/current processing marker
- `Library` — возврат/библиотечный контекст
- `OctagonX` — cancel/failed stop context
- `Play` — продолжение/открытие готового результата, где применимо
- `ChevronLeft`, `ChevronRight` — navigation по queue items
- `CircleAlert` — failure

Modal должен показывать progress, текущий stage и ошибку, если backend её вернул.

---

# 21. Song Settings Modal

Открывается через `Settings2` на song card.

Позволяет изменять song metadata и song-specific karaoke settings.

Минимальные действия:

```text
edit metadata
save
open melody editor
configure video source
```

Использовать:

- `Music2`
- `Save`
- `Piano`

Поддерживается поле `video_url`.

Значение может быть внешним URL или локальным clip-сценарием.

---

# 22. Recordings Modal

Показывает записи пользователя для выбранной песни.

Для каждой записи доступны:

```text
playback
performance analysis
remove recording
```

Использовать:

- `Music2`
- `BarChart3`
- `Trash2`

---

# 23. Performance Analysis Modal

Performance Analysis отображает результат анализа конкретной записи.

Primary visual identity:

- `BarChart3`

Удаление связанной записи:

- `Trash2`

Modal должен показывать summary и детальные метрики, если они есть в backend result.

---

# 24. Online Room — entry point

Из Library пользователь может открыть Online Room через `UsersRound`.

Room flow должен поддерживать минимум:

```text
Create Room
Join Room
Room Code
Host / Participant role
Leave Room
```

---

# 25. Online Room Modal

Room Modal используется до входа или для room-specific setup.

Использовать:

- `UsersRound`
- `ArrowLeft`

Пользователь должен понимать:

```text
создаёт он комнату или подключается
какой room code используется
какое display name будет показано
```

---

# 26. Online Room Dock

После подключения появляется постоянный floating dock в левом нижнем углу.

Dock отображает:

```text
room code
role
participants
speaking levels
transfer status
voice errors
```

Использовать:

- `PanelLeftClose` — свернуть
- `PanelLeftOpen` — открыть
- `Copy` — копировать code
- `Check` — подтверждение copied state
- `ShieldCheck` — запрос microphone permission

---

# 27. Participant Row

Каждый participant имеет собственную строку/карточку.

Показываются:

```text
name
role / self state
speaking level
microphone state
local mute state
volume
effects state
transfer state
```

Использовать:

- `Mic`
- `MicOff`
- `Volume2`
- `VolumeX`
- `Sparkles`
- `Lock`
- `Unlock`
- `LogOut`

---

# 28. Participant Speaking Level

Speaking level отображается через live signal waveform/level visualization.

Это visual feedback, а не отдельный audio path.

Он показывает пользователю, что voice signal обнаружен, но не должен сам управлять media processing.

---

# 29. Participant Volume

Для каждого remote participant пользователь может менять local playback gain.

Control visual:

```text
Volume2 / VolumeX
+
Slider/RotaryKnob
```

Изменение влияет только на локальное восприятие этого участника.

---

# 30. Participant Effects

Room UI поддерживает participant effect controls.

Минимальный набор visual parameters:

```text
volume
reverb
echo
delay
noise suppression
octave
```

Effects surface вызывается через `Sparkles`.

Lock state показывается `Lock` / `Unlock`.

---

# 31. Room transfer status

Если между участниками выполняется передача song/project data, dock показывает:

```text
waiting
sending
receiving
importing
error
```

Для active transfer показывается progress.

Media transfer state не должен скрывать participant audio state.

---

# 32. Room join/leave chime

Для join/leave notification используется:

```text
assets/sounds/room-join-leave.mp3
```

Это короткий interface sound.

Он не заменяет визуальное изменение participant list.

---

# 33. Karaoke route — вход

Karaoke открывается для конкретной готовой песни.

Route всегда получает `songId` и один канонический режим открытия:

```text
KaraokeOpenMode::Normal
KaraokeOpenMode::AutoStart
KaraokeOpenMode::RoomPrepared
```

`Normal` открывает песню в состоянии `Ready` после подготовки.

`AutoStart` после успешной подготовки автоматически запускает playback.

`RoomPrepared` открывает Karaoke как часть уже существующего room session context и после подготовки остаётся в room-controlled состоянии до команды host.

Произвольного `intent` или строковых режимов открытия не существует.

До загрузки всех обязательных данных показывается Karaoke Load State.

---

# 34. Karaoke Load State

Должен различать:

```text
loading songs
song not found
song not processed
result loading
result error
```

Использовать:

- `LoaderCircle` — loading
- `AlertCircle` — error
- `Music2` — song context

Пользователь не должен попадать на пустую сцену.

---

# 35. Karaoke Session

После успешной загрузки создаётся karaoke session.

Frontend получает и отображает:

```text
Song metadata
lyricsSync
playback/session state
room state
recording state
UI preferences
performance visualization
```

Live audio state приходит от `AudioService.exe` через Electron bridge.

---

# 36. Karaoke Scene

Центральная область karaoke должна быть performance-first.

На сцене располагаются:

```text
video/background
karaoke lyrics
piano roll / melody guide
performance state
```

Controls не должны визуально перекрывать основной lyric-reading area.

---

# 37. Karaoke backgrounds

Theme-dependent backgrounds:

```text
assets/karaoke-backgrounds/dark.webp
assets/karaoke-backgrounds/light.webp
assets/karaoke-backgrounds/green.webp
assets/karaoke-backgrounds/violet.webp
```

Дополнительный cinematic asset:

```text
assets/karaoke-backgrounds/multi-nebulae-1.webp
```

Background выбирается по текущей theme/scene configuration.

---

# 38. Song video

Если песня имеет video source, video показывается на сцене.

Поддерживаются:

```text
external video_url
local song clip
```

Видео является визуальным companion к session timeline.

Audio playback остаётся источником timeline truth.

---

# 39. Scene video fallback

Если song-specific video отсутствует, Electron runtime может предоставить общий scene video.

Если и он отсутствует, показывается static/theme scene background.

Таким образом отсутствие видео никогда не делает karaoke невозможным.

---

# 40. Karaoke Lyrics

Lyrics отображаются как primary reading surface.

Для каждого word/character frontend использует timing из `lyricsSync`.

Visual behavior:

```text
future text
current text
filled/highlighted current progress
past text
```

Подсветка следует authoritative session/playback position.

---

# 41. Lyrics Highlight

Highlight должен быть непрерывным и восприниматься как движение внутри текущего слова, а не резкие случайные скачки.

Frontend не пересчитывает текстовую синхронизацию заново; он отображает timing data проекта.

---

# 42. Piano Roll

Karaoke может показывать melody/pitch guide.

Он отображает reference notes относительно session timeline.

Задача:

```text
показать ожидаемую высоту ноты
показать текущее положение песни
помочь пользователю визуально попадать в мелодию
```

---

# 43. Live pitch visualization

При доступном microphone/pitch stream может показываться detected user pitch.

Visualization не должна блокировать lyrics.

Это feedback layer, а не самостоятельный режим приложения.

---

# 44. Karaoke Console

Controls располагаются отдельно от основной сцены.

Основные группы:

```text
Transport
Mixer
Song strip
Tools
Navigation
```

---

# 45. Karaoke Navigation Actions

Использовать:

- `ArrowLeft` — вернуться в Library
- `Radio` — radio/related audio control при доступном сценарии
- `SlidersHorizontal` — открыть/переключить mixer/settings surface

---

# 46. Transport Controls

Использовать:

```text
Play
Pause
Square
SkipBack
SkipForward
ChevronLeft
ChevronRight
Minus
Plus
```

Основные функции:

```text
play
pause
stop
seek
previous/next relevant navigation
playback rate / key / transport adjustment where enabled
```

---

# 47. Song Position

Пользователь видит текущую position и duration.

Waveform/seek control позволяет перейти к новой позиции.

Position UI получает authoritative state из playback/session bridge и может визуально интерполировать между обновлениями.

---

# 48. Karaoke Mixer

Mixer controls frontend отображают состояние AudioService mixer.

Минимальные channels:

```text
Microphone
Music
Vocal/Guide where used
Remote voices / room mix
Master
```

Использовать `Mic` для microphone strip.

Frontend не выполняет PCM mixing самостоятельно.

---

# 49. Karaoke Tools

Tools surface использует:

- `AudioLines` — voice/audio effects
- `Type` — lyrics/display controls
- `MousePointer2` — interaction/display option
- `Cog` — settings

Tools меняют presentation or AudioService parameters, но не создают отдельный browser audio engine.

---

# 50. Microphone controls

Frontend позволяет:

```text
microphone enable/mute
monitoring enable
microphone gain
monitor gain
selected input device via Settings
```

Состояние фактически исполняется AudioService.

---

# 51. Music controls

Frontend позволяет менять:

```text
music gain
play/pause
seek
practice speed presets: 0.50× / 0.65× / 0.75× / 0.85× / 1.00×
```

Music playback осуществляется AudioService, а frontend отображает и управляет состоянием.

---

# 52. Recording in Karaoke

Пользователь может начать и остановить recording прямо во время performance.

UI должен ясно различать:

```text
not recording
starting
recording
stopping/finalizing
failed
```

После завершения запись становится доступной в Library → Recordings.

---

# 53. Room + Karaoke

Если karaoke запускается в room, frontend должен показывать room dock и сохранять participant controls во время performance.

Песня, transport state и room-specific synchronization отображаются как единая session experience.

---

# 54. Performance completion

После окончания karaoke frontend показывает Finished surface с действиями:

```text
return to Library
open recording
open performance analysis
repeat performance
```

Конкретный набор зависит от наличия recording/result.

---

# 55. Melody Editor — назначение

Melody Editor используется для ручной корректировки karaoke timing/notes проекта.

Он открывается для конкретного `songId`.

Основной файл данных — проектная editor payload, основанная на `lyricsSync` и связанных song artifacts.

---

# 56. Melody Editor layout

Редактор полноэкранный и состоит из:

```text
Editor Controls
Timeline / Surface
Words / Notes
Piano Keyboard context
Playhead
Waveform / Transport
```

На этом route обычные floating Library controls не показываются.

---

# 57. Melody Editor loading

До загрузки song/editor payload отображается понятный loading state.

Если данные не загрузились, показывается явное failure/empty state, а не пустая canvas.

---

# 58. Editor Top Controls

Использовать:

- `ArrowLeft` — назад
- `Play`, `Pause` — preview
- `Save` — save
- `Undo2`, `Redo2` — history
- `Trash2` — remove selected
- `Merge` — merge operation
- `Crosshair` — focus/locate
- `ArrowLeftToLine`, `ArrowRightToLine` — boundary operations

---

# 59. Editor playback

Editor preview должен воспроизводить instrumental/vocals через AudioService playback/editor-preview mode в целевой архитектуре.

Frontend управляет transport и отображает playhead.

Он не является источником audio clock.

---

# 60. Editor Surface

Editor Surface показывает:

```text
words
notes
word boundaries
note boundaries
selected state
playhead
```

Пользователь может выбирать и перемещать разрешённые элементы.

---

# 61. Editor note operations

Минимально поддерживаются операции:

```text
select
move/drag
resize/boundary adjustment
merge where permitted
delete
undo
redo
```

Операции должны отражаться в editor document до explicit save.

---

# 62. Editor word-note relationship

Word остаётся смысловой единицей lyrics, note — временной/pitch единицей melody representation.

Frontend не должен скрывать связь note с word при редактировании.

---

# 63. Editor Save

Save фиксирует current editor document через backend project API.

Во время save отображается saving state.

После успешного save UI остаётся в editor и показывает актуальное состояние.

---

# 64. Editor Restore

Restore позволяет вернуть editor document к сохранённой/исходной версии согласно backend contract.

Перед destructive restore может использоваться confirmation dialog.

---

# 65. Editor close/back

При выходе transport останавливается.

Если есть unsaved changes, пользователь должен получить понятный confirmation flow.

---

# 66. Settings — назначение

Settings открывается как global modal и настраивает приложение целиком.

Основные tabs:

```text
Appearance
Audio
AI / Processing
Advanced
```

Иконки:

- `Palette`
- `SlidersHorizontal`
- `Cpu`
- `Wrench`

---

# 67. Appearance Settings

Содержит минимум:

```text
Online display name
Language
Theme
Radio enabled
Radio station
Radio volume
Keyboard lighting enabled
Keyboard lighting mode
Keyboard lighting brightness
Keyboard lighting sensitivity
Keyboard lighting status
```

---

# 68. Language

Поддерживаются:

```text
uk
ru
en
```

Смена языка обновляет UI без переустановки приложения.

---

# 69. Theme selection

Theme selector использует четыре preview assets из `assets/theme-icons/`.

Выбранная тема применяется ко всему приложению, включая karaoke scene palette и reusable UI components.

---

# 70. Radio

Frontend поддерживает встроенное radio как secondary ambient media feature.

Пользователь может:

```text
enable/disable
select station
change volume
```

Global floating radio control отражает текущий state.

---

# 71. Keyboard Lighting

Frontend показывает и управляет keyboard lighting feature.

Поддерживаемые provider concepts:

```text
Windows Dynamic Lighting
USB device integration
OpenRGB
```

User-facing controls:

```text
enabled
mode = music/theme
brightness
sensitivity
status/provider/count
```

---

# 72. Audio Settings

Audio tab является frontend для `AudioService.exe`.

Он должен позволять выбрать/просмотреть:

```text
Input device
Output device
Backend mode
Preferred sample rate
Preferred period/buffer
Channel selection where exposed
Monitoring defaults
Relevant gains
```

---

# 73. Requested vs Runtime Audio

Audio Settings/Diagnostics показывают Requested и Runtime отдельно, не смешивая их:

```text
Requested Configuration — значения в полях формы (то, что выбрал пользователь)
Runtime Configuration   — значения, с которыми AudioService реально работает
```

В Audio Settings отдельного блока с Runtime нет. Runtime показывается под иконкой `ⓘ` в подписи соответствующего поля и читается как `Фактически: <значение>`:

```text
Driver / Backend       → Фактически: WASAPI Shared
Sample Rate            → Фактически: 48 kHz
Period / Buffer        → Фактически: 144 frames · Runtime endpoint buffer: 576 frames
```

Estimated latency и AudioService health показываются отдельной строкой рядом с проверкой аудио (см. §148).

Frontend не должен выдавать preference за фактически применённое значение.

---

# 74. Audio device status

При недоступном выбранном устройстве UI показывает понятное состояние и предлагает выбрать доступное устройство.

Frontend не должен молча подменять отображаемое устройство.

---

# 75. AI / Processing Settings

AI tab управляет offline song-processing configuration.

Здесь размещаются настройки pipeline/models, а не live audio.

Model status может отображаться отдельными status cards.

Использовать:

- `CheckCircle2`
- `AlertTriangle`
- `Download`

---

# 76. Advanced Settings

Advanced tab предоставляет доступ к служебным пользовательским поверхностям:

```text
Memory / Storage
History
Diagnostics
About
```

---

# 77. Memory / Storage Service

Иконка:

```text
Database
```

Показывает:

```text
used cache/data size
free disk space
breakdown
```

Действия:

```text
clear cache
remove temporary files
optimize selected song
```

Удаление данных требует явного пользовательского действия.

---

# 78. History Service

Иконка:

```text
ListChecks
```

Показывает историю действий/processing records с:

```text
timestamp
song
kind
status
```

---

# 79. Diagnostics Service

Иконка:

```text
Stethoscope
```

Frontend diagnostics объединяет сведения минимум из двух источников:

```text
Python backend health
AudioService health/audio-dump summary
```

Пользователь должен видеть, какой subsystem сломан.

---

# 80. Diagnostics status icons

Использовать:

- `CheckCircle2` — healthy
- `CircleAlert` — unhealthy
- `AlertTriangle` — warning

Diagnostics не должна отображать всё одной абстрактной строкой `Error`.

---

# 81. About Service

Иконка:

```text
Info
```

Показывает минимум:

```text
A&D Voice
Frontend version
Python backend version
AudioService version
AI/pipeline version
Data path
Copyright
```

---

# 82. Global Error Boundary

Если React subtree падает, пользователь получает controlled error surface вместо белого окна.

Error Boundary не заменяет subsystem-specific errors, а служит последней защитой UI.

---

# 83. Backend unavailable state

Если Python backend не запустился/недоступен, frontend должен показать состояние bootstrap failure с возможностью повторной попытки или понятным diagnostic message.

Library operations, зависящие от backend, недоступны до восстановления.

---

# 84. AudioService unavailable state

Если `AudioService.exe` недоступен, Library и offline backend functions могут оставаться доступными.

Но:

```text
karaoke playback
monitoring
recording
room media
```

должны быть явно marked unavailable.

---

# 85. Separation of subsystem availability

Frontend различает:

```text
Python Backend availability
AudioService availability
Network/Room availability
```

Ошибка одного subsystem не должна автоматически изображаться как полный crash приложения, если остальные функции ещё доступны.

---

# 86. React Renderer — product-facing responsibilities

React Renderer отвечает за отображение и пользовательское взаимодействие:

```text
Library / Karaoke / Editor / Settings surfaces
UI navigation
Forms and controls
Lyrics / notes / pitch visualization
Room participant UI
Modal/dialog/notification presentation
Loading / empty / error / recovery presentation
Presentation-only preferences
```

React отправляет команды владельцу функции и отображает полученный authoritative state. Он не исполняет live audio, offline processing, filesystem/process lifecycle или native Windows integration.

---

# 87. Python Backend — frontend-facing responsibilities

Frontend использует Python Backend для:

```text
List songs
Song metadata
Import registration
Processing queue
Processing execution/status
AI/ML processing
Editor/project data persistence
Recording metadata
Performance results
History
Storage/cache operations
AI/model status and downloads
About/backend versions
Room control/signaling/auth/session metadata
```

Python Backend никогда не является intermediary для realtime AudioService commands, если команда не относится к Python-owned domain. Например `SetMonitoring`, `SetMixerGain`, `Play`, `Pause` или `StartRecording` не проходят через Python.

---

# 88. AudioService — frontend-facing responsibilities

Frontend использует AudioService для:

```text
Audio device discovery
Runtime audio configuration
Playback
Play / Pause / Seek
Authoritative playback position
Microphone capture state
Monitoring
Mixer gains
Live effects
Radio playback
Editor audio preview
Recording execution and audio-file finalization
Room realtime media
Remote voice state relevant to media
Live audio diagnostics
Latency/runtime status
Audio recovery/reconfiguration
```

Все эти команды идут через Electron Main/Preload bridge напрямую к AudioService control IPC и не маршрутизируются через Python Backend.

---

# 88.1. Electron Main responsibilities as desktop bridge

Electron Main предоставляет React безопасные desktop capabilities:

```text
Window actions
File/folder picking
Reveal/Open folder in Explorer
Clipboard/native desktop actions
Process lifecycle
AudioService IPC bridge
Python backend lifecycle bridge
Scene/local media URL bridge
OS permission/settings bridge
Keyboard-lighting/native Windows integrations
```

React renderer не обращается напрямую к native process handles, filesystem, named pipe, COM/Win32 или unrestricted Node APIs.

---

# 88.2. Command routing model

Каждое пользовательское действие направляется сразу владельцу domain:

```text
Play / Pause / Seek / Monitoring / Mixer / Recording / Live effects
React → Electron Main → AudioService

Import / Process / Reprocess / Library / History / Project Save
React → Electron Main/HTTP bridge → Python Backend

Open Folder / File Picker / Window / Clipboard / Windows Settings
React → Electron Main

Create Room / Join Room / participant control metadata
React → Python room-control API

Remote voice media
AudioService ↔ realtime room media transport
```

Не существует цепочки `React → Python → AudioService` для live audio control только ради посредничества.

---

# 89. Window state

Desktop application сохраняет ожидаемое пользовательское состояние окна:

```text
size
position
maximized state
```

При некорректной сохранённой позиции окно должно оставаться доступным пользователю.

---

# 90. Route transitions

Переход между Library и Karaoke может использовать короткий blackout/fade, чтобы скрыть резкую перестройку полноэкранной scene.

Blackout — transition layer, а не постоянный background.

---

# 91. Karaoke exit

Выход из Karaoke:

```text
останавливает/завершает session согласно выбранному действию
↓
закрывает performance scene
↓
возвращает Library
```

Нельзя оставлять hidden playback после возврата в Library.

---

# 92. Library return state

При возврате в Library сохраняется разумный пользовательский контекст:

```text
search/filter state where appropriate
scroll/selection where feasible
analysis target when переход инициирован из performance result
```

---

# 93. Song processing and UI

Frontend не выполняет offline AI/ML processing сам.

Он показывает:

```text
queued
running stage
progress
completed
failed
```

и позволяет пользователю продолжить работу с Library, если modal/policy это допускает.

---

# 94. Processing failure UX

Ошибка processing должна содержать:

```text
song identity
stage if known
human-readable message
retry/reprocess action where meaningful
```

---

# 95. Song folder action

`FolderOpen` открывает project/song directory через Electron desktop bridge.

Frontend не пытается реализовать filesystem explorer самостоятельно.

---

# 96. Delete song

`Trash2` запускает confirmation flow.

После удаления card исчезает из Library и related modal state закрывается/обновляется.

---

# 97. Reprocess song

`RotateCcw` используется для явного повторного запуска pipeline.

Пользователь должен понимать, что это новая processing operation, а не обычный refresh UI.

---

# 98. Recording analysis flow

Типичный flow:

```text
Library
↓
Recordings
↓
Select Recording
↓
Performance Analysis
```

После возврата пользователь остаётся в контексте выбранной песни.

---

# 99. Media ownership in target frontend

Frontend не создаёт отдельные live `<audio>`/WebAudio paths для microphone/music/remote voices в целевой архитектуре.

Он управляет AudioService и отображает playback state.

Видео остаётся визуальным media element, потому что оно не является audio engine.

---

# 100. Song playback source

Основным song playback source для karaoke является AudioService.

Frontend передаёт ему song/project media identity/path через Electron bridge.

Python backend предоставляет song file locations или authorized media references.

---

# 101. Playback position updates

AudioService отдаёт authoritative playback/session position.

Frontend использует её для:

```text
lyrics
piano roll
waveform
video sync
transport display
```

---

# 102. Video synchronization

Видео синхронизируется с authoritative song position.

При large seek video переходит к соответствующей позиции.

Video playbackRate следует supported song playback rate.

---

# 103. UI update frequency

Frontend не требует audio-rate событий.

Для visual position достаточно UI-friendly update rate, например десятки обновлений в секунду, с интерполяцией между authoritative snapshots.

---

# 104. Accessibility baseline

Interactive controls должны иметь text/ARIA labels даже когда визуально показывается только icon.

Состояния:

```text
pressed
selected
disabled
loading
error
```

должны быть доступны не только цветом.

---

# 105. Keyboard operation

Основные surfaces должны работать без обязательной мыши:

```text
Library search/filter
modals
Settings tabs
transport
Melody Editor hotkeys
```

---

# 106. Localization

Все пользовательские строки проходят через i18n.

Поддерживаемые языки:

```text
Українська
Русский
English
```

Song metadata пользователя не переводится автоматически.

---

# 107. Responsive desktop sizing

Интерфейс рассчитан на desktop window разных размеров и DPI.

Ключевые поверхности не должны требовать фиксированного разрешения:

```text
Library Grid
Settings
Room Dock
Karaoke controls
Melody Editor
```

---

# 108. High-DPI

Иконки Lucide остаются vector-based.

Theme preview/scene images должны масштабироваться без изменения логической layout-сетки.

---

# 109. Loading indicators

Использовать loading UI только там, где действительно выполняется операция.

Для общих loading contexts доступны:

```text
LoaderCircle
Progress
```

UI не должен показывать вечный spinner без error/timeout state.

---

# 110. Success state

Краткие подтверждения могут использовать:

```text
Check
CircleCheck
CheckCircle2
```

в зависимости от поверхности.

---

# 111. Warning / error state

Использовать:

```text
AlertCircle
CircleAlert
AlertTriangle
OctagonX
```

по смыслу поверхности.

Error presentation должна сопровождаться текстом.

---

# 112. Visual hierarchy

Приоритет визуального внимания:

```text
Current task
Primary action
Current state
Secondary actions
Ambient decoration
```

Quantum/nebula/background animation не должна конкурировать с lyrics, dialogs или failure state.

---

# 113. Modal hierarchy

Modal используется для ограниченной задачи, после которой пользователь возвращается в текущий route.

Отдельный route используется для полноэкранной рабочей среды:

```text
Karaoke
Melody Editor
```

---

# 114. Destructive actions

Удаление:

```text
song
recording
cache/temp data
```

должно быть явно отличимо от normal action и при необходимости подтверждаться.

Использовать `Trash2`.

---

# 115. Copy actions

Room code copy использует:

```text
Copy
→ Check после успешного копирования
```

Copied state кратковременный.

---

# 116. Permission flows

Если microphone permission отсутствует, room UI показывает explicit recovery action.

Использовать `ShieldCheck`.

Ошибка permission не должна выглядеть как network disconnect.

---

# 117. Model availability

Если AI model отсутствует, Settings показывает model-specific status и доступное действие загрузки.

Использовать `Download`.

---

# 118. Version visibility

About/Diagnostics должны позволять определить версии основных частей продукта:

```text
Frontend
Python Backend
AudioService
AI / Processing components
```

Это нужно для пользовательского support/diagnostics flow.

---

# 119. Product startup readiness

Приложение считается готовым для interaction, когда:

```text
React mounted
critical global contexts initialized
Python backend status known
AudioService status known
initial route can render
```

Offline Library может открыться даже если AudioService temporarily unavailable, если Python backend работает.

**Экран запуска (splash).** До готовности приложения пользователь видит отдельное **прозрачное окно без рамки, без фона и без текста**, в котором есть только анимированная иконка текущей темы (свечение цвета темы и бегущий блик по форме иконки). Главное окно при этом создано скрытым. Оно показывается, а splash закрывается, когда renderer сообщил, что готов первый настоящий экран: Library либо понятное состояние ошибки. Если renderer не загрузился, главное окно показывается сразу; если ничего не произошло за 90 секунд, оно тоже показывается. Splash закрывается при выходе из приложения.

**Период запуска сервисов.** Python Backend и AudioService стартуют несколько секунд. Пока сервис ни разу не был готов и с запуска прошло меньше 60 секунд, его статус `unavailable` считается `starting` и ошибка не показывается; проверки идут раз в секунду до готовности обоих сервисов, затем раз в 4 секунды. Состояние ошибки показывается, если сервис не поднялся за 60 секунд или пропал после того, как уже работал. Если запуск сервиса завершился ошибкой (нет исполняемого файла), приложение остаётся живым и повторяет попытку.

**Один экземпляр.** Одновременно работает один экземпляр приложения; повторный запуск лишь выводит на передний план окно первого и не останавливает его сервисы.

---

# 120. Primary end-to-end user journey

```text
Launch A&D Voice
↓
Library appears
↓
Find or import song
↓
Process song if needed
↓
Press Play
↓
Karaoke scene opens
↓
AudioService starts playback/monitoring
↓
Lyrics + melody follow session position
↓
Optional recording / online room
↓
Song ends
↓
Return to Library
↓
Open recording / analysis if desired
```

---

# 121. Secondary editor journey

```text
Library
↓
Song Settings
↓
Piano / Melody Editor
↓
Load lyrics/note document
↓
Edit
↓
Preview
↓
Save
↓
Return Library
```

---

# 122. Online room journey

```text
Library
↓
Online Room
↓
Create / Join
↓
Room Dock appears
↓
Participants visible
↓
Prepare song
↓
Karaoke
↓
Room controls remain available
↓
Leave room / return Library
```

---

# 123. Audio settings journey

```text
Open Settings
↓
Audio tab
↓
Select input/output/backend/preferences
↓
AudioService validates and applies session configuration
↓
Frontend shows Runtime values
↓
Close Settings
```

---

# 124. Failure journey — backend

```text
Python Backend unavailable
↓
Bootstrap / affected feature shows error
↓
Retry/recovery
↓
Library refreshes after backend returns
```

---

# 125. Failure journey — AudioService

```text
AudioService unavailable/lost
↓
Live-audio controls disabled
↓
User sees audio-specific error
↓
Electron attempts allowed recovery/restart
↓
Runtime audio state refreshes
```

---

# 126. Failure journey — room

```text
Network/room problem
↓
Room Dock remains visible
↓
Participant/network state updated
↓
Local Library/Karaoke UI remains responsive
```

---

# 127. Project content references

Static content included with this specification:

```text
assets/theme-icons/*.png
assets/karaoke-backgrounds/*.webp
assets/sounds/room-join-leave.mp3
assets/licenses/LICENSE-QFT.txt
```

Lucide icons are identified by component name in `Frontend-content-catalog.md` and should be consumed from `lucide-react`.

Video is runtime/per-song content; see `assets/video/README.md`.

---

# 128. Final frontend product model

The finished frontend behaves as a single desktop product even though it coordinates multiple processes:

```text
                    A&D Voice Frontend
                           │
               ┌───────────┴───────────┐
               │                       │
          Python Backend         AudioService.exe
               │                       │
        Library / AI / Data       Live Audio
               │                       │
               └───────────┬───────────┘
                           │
                        React UI
                           │
            Library / Karaoke / Editor / Settings
```

Пользователь не должен ощущать границы между процессами. Он видит одно приложение с единым состоянием, единым визуальным языком и предсказуемыми переходами.


---

# 129. Полный lifecycle приложения

Frontend должен описывать не только запуск, но и завершение приложения.

Нормальный lifecycle:

```text
Launch
↓
Bootstrap
↓
Ready
↓
Working Session
↓
Close Requested
↓
Graceful Finalization
↓
Window Closed
```

При закрытии приложения необходимо учитывать активные состояния:

```text
Karaoke playing
Recording active
Room active
Song processing active
Editor has unsaved changes
AudioService session active
```

Если идёт запись, приложение сначала инициирует корректный `StopRecording` и ждёт финализацию. Если открыт Melody Editor с несохранёнными изменениями, пользователь получает confirmation dialog. Если активна online room session, выполняется корректный leave/disconnect. После завершения пользовательских операций Electron Main останавливает активную AudioService session, завершает control connections и только затем закрывает desktop window.

---

# 130. First Run Experience

Первый запуск должен быть полноценным продуктовым состоянием, а не просто пустой Library.

Frontend должен уметь одновременно обработать:

```text
Library empty
No saved audio devices
AudioService available but not configured
Required AI models missing
Python backend ready
```

Пользователь видит Library с понятным primary action:

```text
Add your first song
```

Дополнительно приложение мягко подсказывает:

```text
Configure audio
Download required processing models
```

First Run не является отдельным wizard route, если пользователь уже может выполнить эти действия непосредственно из Library/Settings.

---

# 131. Global transient notifications

Кроме modal dialogs приложение имеет единый слой коротких transient notifications.

Использовать для событий, которые не требуют отдельного решения пользователя:

```text
Song imported
Processing started
Processing completed
Recording saved
Copied to clipboard
Settings applied
Device reconnected
Participant joined
Participant left
```

Notification не должна перекрывать системные кнопки title bar и не должна блокировать рабочую поверхность.

Ошибки, требующие выбора или подтверждения, продолжают использовать dialog.

---

# 132. Library при большой коллекции

Library должна одинаково уверенно работать при:

```text
0 songs
10 songs
100 songs
1 000 songs
5 000+ songs
```

Song Grid использует обычный responsive grid для небольшой библиотеки и virtualization для большой коллекции. Пользователь не должен ощущать резкого изменения интерфейса при переключении между режимами.

Library поддерживает:

```text
Search
Filter
Sort
Virtualized scrolling
Persistent scroll position
```

Отдельные состояния:

```text
Empty Library
No Search Results
No Songs Matching Filters
Library Loading
Library Error
```

При возврате из Karaoke или Editor восстанавливаются search, filters, sort и scroll position.

---

# 133. Library sorting

Library обязательно поддерживает сортировку.

Минимальные варианты:

```text
Recently Added
Title A–Z
Artist A–Z
Recently Played
```

Sort является частью Library state и сохраняется между переходами внутри текущей сессии приложения.

---

# 134. Полный import flow

Добавление песни поддерживает:

```text
File Picker
Drag & Drop onto Library
```

После выбора файла frontend показывает:

```text
File name
Detected title / artist when metadata can be read; otherwise filename-derived fallback
Format
File size
```

Отдельно обрабатываются:

```text
Unsupported format
Corrupted/unreadable file
Duplicate file
Song already exists
Import cancelled
Import failed
```

Во время копирования/подготовки файла Song Card может находиться в состоянии `Importing`.

---

# 135. Song Card state/action matrix

Для каждого состояния Song Card действия определены однозначно.

```text
Importing
→ progress
→ Cancel Import

NotProcessed
→ Process
→ Song Settings
→ Open Folder
→ Delete

Queued
→ queue status
→ Cancel Queue Item

Processing
→ progress
→ Open Processing Details

Ready
→ Play Karaoke
→ Recordings
→ Song Settings
→ Open Folder
→ Reprocess
→ Delete

Failed
→ Retry / Reprocess
→ View Error
→ Song Settings
→ Open Folder
→ Delete
```

Недоступные действия не должны выглядеть активными.

---

# 136. Processing Queue

Processing является полноценной фоновой продуктовой сущностью.

Пользователь может поставить несколько песен в очередь.

Состояния job:

```text
Queued
Preparing
Processing
Completed
Failed
Cancelled
```

Processing Modal показывает весь активный queue, текущую стадию и прогресс каждой job. Modal можно закрыть: processing продолжает работать в фоне, а состояние остаётся видно на Song Card.

Поддерживаются:

```text
Cancel queued job
Cancel running job → state `Cancelling`; current non-interruptible stage may finish, but no next stage starts
Retry failed job
Open failure details
```

После restart приложения frontend запрашивает фактический processing state у Python backend, а не восстанавливает его предположением из локального UI state.

---

# 137. Karaoke route identity

Karaoke использует route:

```text
/karaoke/:songId
```

Song ID является частью URL и позволяет корректно восстановить экран после navigation/reload.

Режим открытия передаётся только как `KaraokeOpenMode`:

```text
Normal
AutoStart
RoomPrepared
```

Других значений и произвольного route intent нет.

Room state не кодируется отдельным Karaoke route: room является активным session context.

---

# 138. Karaoke session lifecycle

Karaoke имеет явные пользовательские состояния:

```text
Preparing
Ready
Playing
Paused
Stopping
Finished
Failed
```

`Preparing` означает загрузку song project и подготовку AudioService session.

`Ready` означает, что всё необходимое подготовлено, но playback ещё не начат.

`Playing` и `Paused` отображают фактическое состояние AudioService.

`Stopping` используется при финализации recording/session.

`Finished` отображает результат завершённого выступления.

`Failed` показывает конкретную причину и доступные recovery actions.

---

# 139. Завершение песни

Когда playback достигает EOF:

```text
Playback stops
↓
Active recording stops automatically
↓
Recording finalization completes
↓
Karaoke enters Finished
```

Finished surface предлагает:

```text
Repeat
Back to Library
Open Recording — if recording exists
Open Performance Analysis — shown only when analysis result exists
```

Если recording отсутствует, связанные actions не показываются.

---

# 140. Karaoke Stop / Back

`Stop` завершает текущий playback, но не закрывает Karaoke route автоматически.

`Back` инициирует выход в Library. Если идёт recording или другая незавершённая операция, сначала выполняется корректная finalization или confirmation flow.

---

# 141. Song video rules

Song video является **только визуальным источником** и всегда воспроизводится без собственного audio.

Единственный audio master — AudioService.

Приоритет visual source:

```text
Song-specific video
↓
Generic scene video
↓
Theme karaoke background
```

Если video load падает, Karaoke автоматически переходит к следующему доступному visual source без остановки audio session.

Video обязан следовать authoritative playback position AudioService для:

```text
Play
Pause
Seek
Playback rate change
Restart
```

---

# 142. Karaoke content fallback states

Karaoke должен корректно работать при неполном song project.

```text
Instrumental only
Lyrics without notes
Lyrics without pitch reference
Notes without live pitch reference
No video
No artwork
```

Если lyrics отсутствуют, центральная сцена показывает instrumental visual mode вместо пустого lyric area.

Если piano-roll data отсутствует, Piano Roll не показывается.

Если live pitch reference отсутствует, live pitch comparison скрывается, но microphone monitoring остаётся доступным.

---

# 143. Karaoke stage layers and console auto-hide

Слои сцены включаются независимо двумя переключателями в консоли:

```text
Notes (Piano Roll)
Text (lyrics)
```

Слой недоступен и его переключатель отключён, если song project не содержит нужных данных. Если не показан ни один слой (выключены оба или нет данных), показывается минимальная сцена с названием песни. Оба переключателя сохраняются как пользовательские preferences.

Консоль поддерживает автоскрытие (переключатель «Автоскрытие», по умолчанию включён): во время воспроизведения она плавно уходит после ~2 секунд без активности и возвращается при движении указателя, нажатии клавиши или смене полноэкранного режима. На паузе, при ошибке и после завершения консоль остаётся видимой.

Эффекты голоса (эхо, реверберация, задержка) и их пресеты живут только в консоли Karaoke и комнаты; шумоподавление настраивается ротари-ручкой в настройках программы и применяется в Karaoke. Тест мониторинга в настройках всегда воспроизводит чистый голос. Октавы в консоли нет.

Открытие Karaoke из библиотеки: библиотека затемняется, сцена показывает название и исполнителя песни, затем экран проясняется и воспроизведение стартует само. Кнопки «назад» и «показать/скрыть консоль» стоят в строке тайтл-бара и исчезают после ~2 секунд без движения мыши во время воспроизведения.

Записи и анализ используют один плеер (play/pause, waveform с перемоткой, время, громкость); воспроизведение идёт через AudioService (`LoadRecordingPreview`, `PlayRecordingPreview`, `SeekRecordingPreview`), позиция читается из диагностики (`PreviewState`, `PreviewPositionFrames`). Окно анализа показывает плеер и кнопку удаления записи, карусель записей песни и оценку с рекомендацией.

---

# 144. Melody Editor interaction model

Melody Editor является полноценной рабочей поверхностью редактирования.

Обязательные операции:

```text
Horizontal timeline scroll
Zoom in / zoom out
Vertical pitch range
Playhead positioning
Follow playhead toggle
Single note selection
Multi-selection
Drag selected notes
Resize note start/end
Delete
Merge
Undo
Redo
Save
Restore original
```

Snapping включается к логической временной сетке editor model и не должен мешать точному ручному редактированию: пользователь может временно отключить snapping.

---

# 145. Melody Editor dirty state

После первого изменения Editor получает `dirty` state.

При попытке:

```text
Back
Close application
Open another song
Restore
```

пользователь получает выбор сохранить, выйти без сохранения или отменить действие.

После успешного Save dirty state сбрасывается.

При Save failure изменения остаются в editor memory, чтобы пользователь мог повторить сохранение.

---

# 146. Editor backend conflict

Если song project изменился извне после открытия editor, frontend не должен молча перезаписывать новые данные.

Показывается conflict state с выбором:

```text
Reload latest project
Keep current local edits and explicitly overwrite latest project after confirmation
Cancel
```

---

# 147. Settings apply model

**Все настройки сохраняются и применяются автоматически в момент изменения.** В Settings нет кнопок `Apply`, `Cancel pending changes`, `Reset section to defaults` и нижней панели действий; закрытие происходит крестиком окна.

```text
Theme, Language, Visual preferences, Radio, Display name, Microphone volume
→ применяются и сохраняются сразу

Audio device / backend / sample rate / period
→ сохраняются как requested-конфигурация сразу и сразу же передаются AudioService
```

Правила автоприменения audio-конфигурации:

- выбор сохраняется как requested-конфигурация, даже если AudioService сейчас не может её применить;
- команды применения выполняются строго по очереди, новая не обгоняет предыдущую;
- успешное применение молчит, а результат виден в `ⓘ` (Runtime); неудача показывается уведомлением с причиной;
- Restart-required используется только для параметров, которые действительно невозможно безопасно применить во время работы, и UI явно показывает это до изменения.

Формы Settings строятся через `GetForm`/`RenderFormikFields` (см. technology contract §22); текстовые поля сохраняются по потере фокуса, остальные — по изменению значения.

---

# 148. Audio Settings — полный UX

Audio Settings дают пользователю возможность самостоятельно проверить аудиосистему.

Поля (двухколоночная сетка, значения Runtime — под `ⓘ`):

```text
Backend                    (ⓘ Фактически: backend)
Sample Rate                (ⓘ Фактически: sample rate)
Period / Buffer            (ⓘ Фактически: period + endpoint buffer)
Input Device
Output Device
```

Список Input/Output Device всегда содержит пункт `System default`, из которого можно выбрать конкретное устройство и к которому можно вернуться. Если выбранное устройство исчезло, оно остаётся выбранным и помечается `Device unavailable`; UI не подменяет его другим устройством автоматически.

Инструменты и показатели:

```text
Input Test (Switch)         — включает мониторинг микрофона и живую волну уровня
Live Input Level            — LiveSignalWaveform (зеркальная бегущая волна в цветах темы)
Microphone Volume           — RotaryKnob, 0–150 %, сразу применяется и сохраняется
Test Output                 — воспроизводит тестовый звук
Estimated Latency + Health  — расчётная задержка (мс) и состояние AudioService
```

`Input Test` — это переключатель, а не кнопка на несколько секунд: проверка идёт, пока пользователь сам её не выключит или не выйдет из Settings. При выходе из Settings проверка выключается, а мониторинг отключается автоматически, даже если он был включён. Под переключателем показывается предупреждение про наушники (иначе возможен свист).

Estimated Latency считается AudioService как сумма периода и заявленной драйвером задержки на входе и на выходе плюс внутренние буферы; она появляется после старта аудиосессии.

Если AudioService недоступен, показывается Alert с объяснением, а `Input Test` и `Test Output` недоступны; сами поля формы остаются доступными, выбор сохраняется.

---

# 149. Online Room authority model

В room существует роль:

```text
Host
Participant
```

Host управляет общей karaoke session:

```text
Select song
Start
Pause
Seek
Stop
Close room
Kick participant
Transfer host role
```

Participant не может изменять общий transport без host authority.

Participant всегда может управлять собственными локальными настройками:

```text
Own microphone mute
Own monitor gain
Local volume of each remote participant
Local display preferences
```

---

# 150. Room song synchronization

Room karaoke запускается только после готовности участников.

```text
Host selects song
↓
Clients check local song project
↓
Missing project is transferred from Host through room transfer flow
↓
Each client reports Ready
↓
Host starts countdown
↓
Authoritative room start position/time distributed
↓
Each AudioService starts local playback against room timeline
```

Late join подключается к текущей room position и не начинает песню с начала.

---

# 151. Room reconnect

При кратковременном disconnect participant переходит в reconnecting state.

После успешного reconnect frontend получает актуальный room snapshot:

```text
Current host
Participants
Current song
Playback state
Playback position
Room permissions
```

Клиент синхронизируется с актуальной room session и не воспроизводит накопленный старый audio.

---

# 152. Host leaves room

Если host выходит добровольно, UI требует выбрать:

```text
Transfer Host
или
Close Room
```

При неожиданном disconnect host начинается 10-секундный grace period. Если host не вернулся, роль автоматически передаётся подключённому участнику с самым ранним join order. Если других участников нет, room закрывается. Все клиенты получают новый authoritative room snapshot.

---

# 153. Room capacity and join failures

Room UI различает:

```text
Invalid room code
Room not found
Room full
Room closed
Version incompatible
Song transfer failed
Microphone permission denied
Network unavailable
```

---

# 154. Recording lifecycle

Каждая запись является отдельным take.

Frontend отображает:

```text
Song
Date/time
Duration
Take number/name
Analysis status
File status
```

Поддерживаются:

```text
Playback
Open Analysis
Delete
Open Folder
```

При failed finalization запись получает отдельный error state и не показывается как корректно завершённая.

---

# 155. Recording after crash

Если приложение или AudioService аварийно завершились во время записи, при следующем запуске backend/history layer должен определить recoverable partial recording. Frontend показывает её отдельно как `Recovered/Incomplete` и не выдаёт за обычный finished take.

---

# 156. AI Model download lifecycle

Для каждой необходимой модели UI поддерживает:

```text
Not Installed
Downloading
Ready
Failed
Model Update Available
```

Перед Download показываются:

```text
Model name
Approximate download size
Required disk space
```

Во время загрузки:

```text
Progress
Cancel
```

При ошибке:

```text
Retry
Error details
```

---

# 157. Persistence matrix

Между запусками приложения сохраняются:

```text
Theme
Language
Window size / position / maximized state
Library sort
Audio device IDs and preferred configuration
Mixer default gains
Karaoke display preference
Reduced motion preference
Radio station and volume
Keyboard lighting preference
```

Search query и временные modal states не обязаны сохраняться после полного restart.

Любое сохранённое Device ID при startup заново валидируется через AudioService.

---

# 158. Keyboard shortcuts

Глобальные shortcuts не должны конфликтовать между рабочими зонами.

Минимум:

```text
Space      → Play / Pause in Karaoke or Editor when focus is not in text input
Esc        → Close top modal / exit transient surface
Ctrl+S     → Save in Melody Editor
Ctrl+Z     → Undo in Melody Editor
Ctrl+Y     → Redo in Melody Editor
Delete     → Delete selected editor note(s)
F11        → Karaoke fullscreen toggle
```

Перед выполнением shortcut frontend учитывает focused input/control.

---

# 159. Reduced Motion

Приложение поддерживает `Reduce animations`.

Preference может быть выбрана пользователем и по умолчанию уважает системную Windows reduced-motion preference.

При включении:

```text
Quantum Field intensity reduced/disabled
Route animations shortened
Modal animations simplified
Decorative karaoke motion reduced
```

Audio, lyrics synchronization, live pitch и функциональные progress indicators продолжают работать полностью.

---

# 160. Desktop window behaviour

Frontend определяет:

```text
Minimum window size
Normal window state
Maximized state
Karaoke fullscreen state
```

Window size и position сохраняются между запусками. Если сохранённая позиция больше не находится на существующем monitor после изменения monitor configuration, окно возвращается на primary display в видимую область.

Karaoke fullscreen скрывает обычный nonessential chrome, но системный exit/fullscreen control остаётся доступным согласно title-bar/window policy.

---

# 161. Application identity assets

Проект должен иметь отдельные product assets:

```text
Application icon
Window icon
Installer icon
Text label `A&D Voice` rendered with the product typography; отдельный logo/wordmark asset в v1 не используется
Fallback participant avatar/initials treatment
Empty Library illustration or icon composition
Generic error-state icon composition
```

До появления уникальных иллюстраций допускается использовать композиции на базе Lucide icons и typography, но это должно быть одинаково во всём приложении.

---

# 162. Diagnostics support flow

Diagnostics предоставляет:

```text
Copy Diagnostics
Export Diagnostics Report
```

Экспорт содержит технический snapshot приложения, Python backend и AudioService без пользовательского audio content.

Это основной способ передать техническую информацию для поддержки.

---

# 163. Protocol incompatibility

Frontend отдельно различает:

```text
Python Backend unavailable
AudioService unavailable
Python protocol incompatible
AudioService IPC protocol incompatible
```

Version mismatch показывает конкретные версии и рекомендуемое действие, а не generic connection error.

---

# 164. Application update policy

Автоматическое обновление приложения **не входит в первую версию этой frontend specification**.

Frontend v1 не проверяет наличие новой версии, не показывает `Update Available`, не скачивает update package и не предлагает install/restart для обновления.

Frontend обязан только показывать текущую application version в About. Download/install/update lifecycle рассматривается отдельной будущей спецификацией.

---

# 165. Product State Model

Для описания пользовательского поведения проект использует следующие продуктовые состояния:

```text
BootstrapState
LibraryState
ImportState
ProcessingState
KaraokeSessionState
RecordingState
RoomState
EditorState
SettingsState
AudioAvailabilityState
BackendAvailabilityState
```

Это не требование к количеству React stores или классов. Это перечень пользовательских состояний, которые frontend обязан уметь корректно отобразить.

---

# 166. Modal and overlay layering

Приложение использует однозначную визуальную и интерактивную иерархию.

```text
Base Route Surface
↓
Route-local Popovers / Menus
↓
Global Dock / Floating Controls
↓
Settings / Application Modals
↓
Confirmation / Critical Dialog
↓
Desktop Title Bar System Buttons
```

**Desktop title bar system buttons всегда являются верхним слоем.**

Даже когда открыт:

```text
Settings
Processing Modal
Song Settings
Recordings
Performance Analysis
Online Room Modal
Confirmation Dialog
Critical Error Dialog
Global blackout / transition overlay
```

кнопки `Minus`, `Maximize2` и `X` остаются визуально поверх этих поверхностей и принимают pointer input.

---

# 167. Финальная product readiness model

Frontend считается полностью готовым как продукт, когда пользователь может пройти без внутренних knowledge assumptions следующие сценарии:

```text
First launch
Configure audio
Import first song
Process song
Start local karaoke
Monitor microphone
Record performance
Review recording
Edit melody
Create/join room
Synchronize room song
Recover from device/service disconnect
Return to Library
Close application safely
```

Каждый сценарий должен иметь полноценные loading, empty, success, warning, error и recovery states там, где они возможны.

---

# 168. Practice speed, key and vocal range

Karaoke v1 поддерживает ровно три связанные пользовательские возможности:

```text
Practice Speed
Key Transpose
Vocal Range Display
```

`Practice Speed` меняет скорость/tempo playback с сохранением высоты тона и имеет фиксированные presets:

```text
0.50×
0.65×
0.75×
0.85×
1.00×
```

`Key Transpose` изменяет высоту музыкального playback на целое число полутонов в диапазоне:

```text
-12 ... 0 ... +12 semitones
```

Темп и key отображаются рядом с song information. Отдельного второго независимого tempo slider в v1 нет: управление темпом выполняется через `Practice Speed`.

`Vocal Range Display` управляет вертикальным диапазоном piano-roll/live-pitch визуализации и не меняет audio signal.

Во время активной recording-сессии `Practice Speed` и `Key Transpose` заблокированы. В online room host выбирает их до countdown; после начала performance они блокируются для всех участников до Stop/Finish.

---

# 169. Song Settings — точный состав

Song Settings всегда содержит:

```text
Title
Artist
Language
Cover Artwork
Song Video
Default Key
Detected BPM / Tempo information
Default Practice Speed
Default Vocal Range Display
Project Format Version
Processing Status
Open Melody Editor
Open Folder
Reprocess
Delete Song
```

Ручные поля `Title`, `Artist`, `Language`, `Cover Artwork`, `Song Video`, `Default Practice Speed` и `Default Vocal Range Display` применяются без reprocess.

Изменение исходного audio source, processing profile или AI/pipeline parameters требует `Reprocess`.

Detected BPM/key могут быть отображены как результат processing. Ручной `Default Key` является пользовательским override и не перезаписывается последующим reprocess без отдельного подтверждения.

---

# 170. Cover Artwork lifecycle

Каждая Song Card имеет cover.

Приоритет:

```text
User-selected cover
↓
Imported embedded artwork
↓
Generated/fetched project artwork
↓
Application fallback artwork
```

Пользователь может:

```text
Replace Cover
Remove Custom Cover
```

Удаление custom cover возвращает следующий доступный fallback, а не пустую карточку.

Cover отображается в квадратном `1:1` container через `object-fit: cover`. До загрузки показывается deterministic fallback surface на основе theme и `Music2` icon.

---

# 171. Delete Song semantics

`Delete Song` является destructive action и всегда требует confirmation.

При подтверждении приложение удаляет:

```text
Library record
Managed imported song copy
Generated project/artifacts
Song-specific cached media
All recordings/takes for this song
Performance-analysis records for these takes
```

Если исходный файл был импортирован по ссылке из внешней пользовательской папки и не копировался в managed storage, внешний original file никогда не удаляется.

Confirmation показывает количество recordings и предупреждает, что generated project data будет удалена.

---

# 172. Processing cancellation semantics

Cancellation v1 определена однозначно.

```text
Queued
→ Cancel immediately
→ Cancelled
```

```text
Running
→ Cancel requested
→ Cancelling
→ текущая non-interruptible стадия завершается безопасно
→ следующая стадия не запускается
→ Cancelled
```

Frontend никогда не показывает Cancel как выполненный, пока backend не подтвердил terminal state `Cancelled`.

---

# 173. Room project transfer

Online Room v1 поддерживает передачу отсутствующего processed song project от Host участникам.

Передаётся только managed karaoke project package, необходимый для воспроизведения текущей песни:

```text
project metadata
lyrics/timing data
required playback media
required visual project media
```

Transfer flow:

```text
Missing Song
→ Preparing Transfer
→ Downloading
→ Verifying
→ Preparing Audio
→ Ready
```

Передача показывает bytes/progress, поддерживает Cancel и Retry. Package имеет project format version, expected size и checksum. После download checksum обязан совпасть до перехода в `Preparing Audio`.

Ошибки:

```text
Insufficient disk space
Transfer interrupted
Checksum mismatch
Unsupported project version
Host no longer available
```

Partial invalid package не используется для Karaoke и очищается или помечается для safe retry.

---

# 174. Room readiness model

Для каждого participant Host видит одно из состояний:

```text
Missing Song
Preparing Transfer
Downloading
Verifying
Preparing Audio
Ready
Failed
Disconnected
```

Countdown разрешён только когда все подключённые участники находятся в `Ready` либо Host явно удалил неготового participant из room.

---

# 175. Recording storage policy

Recordings хранятся только в managed application recordings directory.

Структура логически разделяется по song ID и take ID.

Имя take в UI формируется как:

```text
Take N · YYYY-MM-DD HH:mm
```

Пользователь может задать display name take вручную.

Поддерживаются:

```text
Play
Rename Take
Open Analysis
Open Folder
Delete Recording
```

`Delete Recording` удаляет managed audio file и связанные analysis records после confirmation.

Audio file не удаляется автоматически по сроку хранения. Очистка выполняется только пользователем через Recording/Storage UI.

---

# 176. History scope

History имеет две вкладки:

```text
Performances
Processing
```

`Performances` показывает завершённые локальные и room karaoke sessions:

```text
Timestamp
Song
Local / Room
Recording take if exists
Analysis status
```

`Processing` показывает processing jobs:

```text
Timestamp
Song
Result
Duration
Failure summary if any
```

History не является системным log viewer; технические ошибки находятся в Diagnostics.

---

# 177. Radio behaviour

Radio v1 существует только как Library background listening feature.

Radio playback выполняется через AudioService, чтобы в приложении не существовало второго browser audio engine.

Сохраняются:

```text
Last selected station
Radio volume
```

При переходе в Karaoke или Melody Editor radio автоматически останавливается до запуска новой рабочей audio session.

Radio не воспроизводится одновременно с Karaoke/Editor preview.

---

# 178. Keyboard lighting availability

Keyboard Lighting UI показывается только если Electron/native capability detection нашёл совместимое lighting device.

Если совместимого устройства нет, отдельная пользовательская секция Lighting скрыта. Diagnostics при этом может показать:

```text
Keyboard Lighting: Unsupported / No compatible device
```

Если устройство исчезает во время работы, lighting controls закрываются/disabled, а основное приложение продолжает работу.

---

# 179. Windows microphone privacy state

Audio availability различает:

```text
Microphone Ready
Permission Denied for Application
Microphone Access Disabled in Windows Privacy Settings
Input Device Missing
Input Device Busy/Unavailable
```

При Windows privacy denial UI показывает причину и действие:

```text
Open Windows Microphone Privacy Settings
```

Karaoke без микрофона остаётся доступным как playback/lyrics experience.

---

# 180. Closing application while processing

Background/headless processing после закрытия desktop application в v1 не поддерживается.

Если существуют active processing jobs при Close:

```text
Cancel jobs and exit
Keep application open
```

При выборе exit queued jobs отменяются сразу, running jobs переходят в `Cancelling` и приложение ждёт safe cancellation confirmation перед shutdown Python backend.

---

# 181. Recovery after previous crash

При следующем startup frontend запрашивает recovery state.

Возможные результаты:

```text
Recovered/Incomplete recording found
Interrupted processing job found
Unsaved Melody Editor recovery draft found
Previous room session was interrupted
```

Поведение:

- partial recording предлагается открыть/сохранить/delete как `Recovered/Incomplete`;
- interrupted processing job получает `Interrupted` и действие `Retry`;
- Melody Editor draft предлагает `Restore Draft` или `Discard`;
- room автоматически не rejoin'ится после application crash; пользователь получает informational notification и может войти снова вручную.

---

# 182. Processing metadata vs manual user metadata

Processing не имеет права молча перезаписывать пользовательские overrides.

Поля имеют origin:

```text
Automatic
Manual
```

Новый processing result обновляет automatic metadata, но manual `Title`, `Artist`, `Language`, custom cover и manual default key сохраняются.

UI может предоставить `Use detected value` для возврата конкретного поля под автоматическое управление.

---

# 183. Library search behaviour

Search работает по:

```text
Title
Artist
Original/imported filename
```

Search:

```text
case-insensitive
Unicode-normalized
partial substring match
150 ms debounce
```

Транслитерационный/fuzzy search не входит в v1.

`X` внутри SearchField очищает query одним действием.

---

# 184. Deterministic sorting

Все Library sorts стабильны.

Secondary order:

```text
Title normalized A–Z
↓
Artist normalized A–Z
↓
Stable Song ID
```

Это предотвращает случайное перемещение карточек при одинаковом primary sort value.

---

# 185. Fullscreen and title-bar system controls

Даже в Karaoke fullscreen системные controls приложения остаются видимы как компактный top-right overlay:

```text
Minus
Maximize2 / Restore
X
```

Они не скрываются по hover и всегда кликабельны.

Fullscreen скрывает остальной nonessential title-bar chrome, но не эти три system buttons.

Абсолютная layering policy:

```text
Title Bar System Controls = highest application z-layer
Modal backdrops terminate below system-controls layer
System-controls pointer events = always enabled
No modal, blackout, popover or drag-region may intercept them
```

---

# 186. Settings при закрытии

У Settings нет dirty state и подтверждения при закрытии: все изменения уже сохранены (см. §147).

При закрытии Settings (`X`, `Esc`, click outside, route change, закрытие приложения):

```text
Input Test выключается
мониторинг микрофона отключается
```

---

# 187. Seek and recording

Во время активного local recording:

```text
Seek = disabled
Practice Speed = disabled
Key Transpose = disabled
```

`Play/Pause` разрешены; pause создаёт осознанную паузу performance timeline согласно AudioService recording contract.

После Stop/Finalize controls снова доступны.

В online room после начала countdown общий Seek также заблокирован до Stop/Finish. Host сохраняет Play/Pause/Stop authority.

---

# 188. Room playback parameter authority

До countdown Host задаёт:

```text
Practice Speed
Key Transpose
```

Эти значения входят в authoritative room session snapshot.

После countdown они immutable до завершения performance.

Participant не может менять local playback speed/key независимо от room, потому что это разрушило бы общую timeline synchronization.

---

# 189. Karaoke without microphone

Karaoke полностью работает без input microphone.

В таком режиме доступны:

```text
Playback
Lyrics
Piano Roll if project has it
Video/background
Room listening
Transport
```

Скрываются/disabled:

```text
Monitoring
Mic Gain
Live Pitch
Voice Recording
Voice Analysis dependent on mic
```

UI не считает отсутствие microphone fatal error для обычного playback.

---

# 190. Local microphone scope in v1

Frontend v1 поддерживает один local microphone source на одну AudioService session.

Audio Settings позволяет выбрать:

```text
Input Device
Input Channel / channel pair exposed by backend
```

Одновременный mix нескольких физических local microphones не входит в v1.

---

# 191. Song Project Format Version

Каждый processed song project имеет обязательное:

```text
projectFormatVersion
```

Frontend/Python backend проверяют compatibility до открытия Karaoke или Melody Editor.

Состояния:

```text
Compatible
Upgrade/Reprocess Required
Unsupported Newer Project Version
Invalid Project
```

Если `projectFormatVersion` ниже минимально поддерживаемой версии, UI предлагает `Reprocess / Upgrade Project`.

Для project новее текущего приложения UI предлагает обновить приложение и не пытается интерпретировать неизвестный format.

---

# 192. Corrupted/invalid song project

Если обязательный project artifact отсутствует, повреждён или не проходит validation, Song Card получает:

```text
Project Invalid
```

Действия:

```text
View Details
Repair/Reprocess
Open Folder
Delete
```

`Play Karaoke` заблокирован до восстановления project consistency.

---

# 193. Insufficient disk space

Перед операциями, которые могут существенно записывать данные, frontend/backend выполняют storage check:

```text
Import
Processing
AI model download
Room project transfer
Recording start
```

При недостаточном месте показывается единое состояние:

```text
Insufficient disk space
Required: X
Available: Y
Open Storage Settings
```

Операция не стартует частично, если минимально необходимое место заведомо отсутствует.

---

# 194. Python backend reconnect while Library is open

После reconnect Python backend frontend обязательно заново получает authoritative snapshots:

```text
Library
Processing Queue
History summary
Model states
Storage state
```

Старый renderer state не считается актуальным только потому, что экран не перезагружался.

---

# 195. AudioService restart during Karaoke

При неожиданном AudioService restart active Karaoke автоматически переходит:

```text
Playing/Paused
→ Recovering Audio
→ Paused
```

После reconnect frontend восстанавливает song/session configuration и фактическую position, но **не запускает playback автоматически**.

Пользователь получает:

```text
Audio recovered
Resume
Stop
Open Audio Settings
```

Это предотвращает неожиданное возобновление громкого audio после recovery.

---

# 196. Canonical z-order contract

Application z-order фиксирован и не зависит от конкретной страницы:

```text
0   Route content
100 Route-local floating surfaces
200 Global dock/floating controls
300 Settings / standard modals
400 Confirmation / critical dialogs
500 Transition blackout visual content
1000 Desktop Title Bar System Controls
```

Числа описывают относительный contract, а не обязательно literal CSS values.

`Desktop Title Bar System Controls` всегда:

```text
visible
pointer-enabled
outside modal focus-blocking backdrop hit area
outside Electron drag-region
```

Focus trap модалки не должен блокировать mouse activation системных title-bar buttons.

---

# 197. Final normative rule for product specification

Эта specification является нормативной для frontend v1.

Формулировки вида:

```text
if supported
if product requires
where applicable
may
может
```

не должны использоваться для неопределённых продуктовых решений. Если внешняя возможность действительно зависит от hardware/backend, документ должен описывать **оба конкретных observable states**, например `Supported` и `Unsupported`, а не оставлять решение разработчику.

Все дальнейшие архитектурные и implementation документы обязаны реализовывать именно описанное здесь product behaviour и не добавлять скрытые альтернативные flows.


> **Greenfield premise:** этот документ описывает новый frontend-проект A&D Voice, создаваемый полностью с нуля. Он не является планом миграции, рефакторинга или замены существующего frontend. Все разделы описывают только каноническое конечное поведение нового продукта и его системные границы с первого дня.

---

# Addendum A — Оболочка интерфейса (нормативно)

Этот раздел описывает уже реализованную визуальную оболочку приложения. Она является частью продукта; при расхождении с более ранними разделами действует этот addendum.

## A1. Фон приложения

Фоном **всего приложения** (Library, Settings, Melody Editor, Online Room, стартовые и ошибочные экраны, а также под модальными окнами) служит картинка текущей темы из `assets/karaoke-backgrounds` (`dark`, `light`, `green`, `violet`) с анимацией Quantum Fields поверх: изолированный runtime (iframe, `three`) рисует частицы; в светлой теме слой частиц инвертируется. Анимация монтируется **один раз на всё приложение** и не перезапускается при переходах между экранами. Затемнения или высветления картинки нет: яркость одинакова во всех темах. Karaoke-сцена поверх фона рисует собственную сцену (картинка темы и видео).

Анимация реагирует на звук: AudioService считает 18 полос спектра финального микса (радио, музыка, микрофон, тесты; команда `GetSpectrum`), frontend опрашивает её около 20 раз в секунду, пока сервис готов, окно видно и запросы не мешают обычным командам, и передаёт бас и полосы runtime анимации. Если звука нет, анимация продолжает жить в спокойном режиме.

Пока страница не загружена, тема применяется до первой отрисовки, чтобы не было вспышки неправильного цвета.

## A2. Иконка приложения

Иконка темы из `assets/theme-icons` используется: в шапке Library, на splash-экране и как **иконка окна на панели задач**. При смене темы иконка окна меняется вместе с ней; последняя выбранная тема запоминается для следующего запуска.

## A3. Library

Шапка Library состоит из: крупной иконки темы (адаптивный размер), строки-подзаголовка, заголовка `A&D Voice` и двух карточек статистики (`Всего песен`, `Готово к караоке`).

Под шапкой одна строка действий: крупное поле поиска со значком лупы и кнопкой `SlidersHorizontal`, затем кнопки `Очередь обработки`, `Онлайн-комната` и главная `Добавить песню`. Кнопка `SlidersHorizontal` открывает Popover: сортировка (`Недавно добавленные`, `Название А–Я`, `Исполнитель А–Я`, `Недавно воспроизведённые`) кнопками, `Фильтр статуса` селектом, кнопки `Применить` и `Сбросить`. Изменения фильтров применяются только по `Применить`.

Пустая библиотека показывает крупный заголовок и **в один ряд** три действия одного размера: `Добавьте первую песню`, `Настроить аудио`, `Скачать необходимые модели обработки` (последняя открывает Settings на вкладке AI / Processing, где модели скачиваются).

Все размеры и отступы страниц задаются viewport-relative токенами kit, поэтому интерфейс масштабируется под любые экраны и масштаб Windows.

## A4. Floating controls и Popover радио

Кнопки `Radio` и `Settings` в правом нижнем углу имеют адаптивный размер (примерно 3,5–6 rem) и крупные иконки. Popover громкости радио появляется при hover/focus на включённом радио и **исчезает**, как и любой другой popover: при уходе курсора, по клику вне и по `Esc`.

## A5. Прокрутка

Полосы прокрутки везде оформлены под тему: тонкий скруглённый ползунок цвета темы со свечением, прозрачная дорожка, без стрелок.

## A6. Формы

Все формы строятся через `GetForm`/`RenderFormikFields`; поля-иконки `ⓘ` в подписях показывают пояснения и Runtime-значения, линия рамки поля не пересекает иконку. Форма показывает общую ошибку один раз под полями, а не под каждым полем. Модальные окна имеют внутренние отступы токенами kit.

## A7. Режим разработки

`start.bat dev` запускает renderer на dev-сервере Vite: сохранённые изменения во frontend применяются сразу без пересборки. Изменения в `frontend/electron` требуют перезапуска. Обычный `start.bat` собирает и запускает production-сборку.
