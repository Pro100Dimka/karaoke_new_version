# Каталог контента frontend

## 1. Темы

Frontend поддерживает четыре визуальные темы:

- `dark`
- `light`
- `green`
- `violet`

Для выбора темы используются preview-изображения:

- `assets/theme-icons/dark.png` — 500×500 RGBA
- `assets/theme-icons/light.png` — 500×500 RGBA
- `assets/theme-icons/green.png` — 500×500 RGBA
- `assets/theme-icons/violet.png` — 500×500 RGBA

## 2. Karaoke / scene backgrounds

- `assets/karaoke-backgrounds/dark.webp`
- `assets/karaoke-backgrounds/light.webp`
- `assets/karaoke-backgrounds/green.webp`
- `assets/karaoke-backgrounds/violet.webp`
- `assets/karaoke-backgrounds/multi-nebulae-1.webp` — 4096×2048, дополнительный cinematic/space backdrop.

Эти объекты используются как визуальная сцена, а не как UI-иконки.

## 3. Library background

Картинка выбранной темы из `src/assets/karaoke-backgrounds/` задана на `.appTheme`. В видимой Library работает `LibraryBackdrop` с `QuantumBackground` из `@neo-ui-kit/react`, спектром AudioService и уровнем микрофона. Скрытая под Settings страница приостанавливается; Reduced Motion и невидимость окна отключают движение, idle сам по себе не меняет preference. `three` поставляется локально. На карточках песен декоративного эквалайзера нет.

## 4. Звуковой UI-контент

- `assets/sounds/room-join.mp3` — короткий системный room chime для входа участника.
- `assets/sounds/room-leave.mp3` — отдельный системный room chime для выхода участника.

Он не является музыкальной дорожкой песни и не должен смешиваться с библиотечным контентом.

## 5. Видео песни

Frontend должен поддерживать:

- внешний `video_url`;
- локальный clip песни, предоставленный backend;
- отсутствие видео.

Если видео отсутствует, karaoke-сцена продолжает полноценно работать на theme/scene backdrop.

## 6. Scene video

Electron runtime может предоставить отдельный scene media URL. Он используется только как визуальный фон karaoke-сцены и не является источником audio timeline.

## 7. Обложка песни

`SongCard` показывает artwork справа через `object-fit: contain`, а название, исполнителя и действия слева. Без картинки тематическая поверхность и содержимое занимают всю карточку. Новый импорт не извлекает embedded artwork: автоматическая картинка получается online и кешируется backend; ручной custom cover имеет приоритет. Отсутствие картинки не блокирует обработку или Karaoke.

## 8. Иконки UI-кита

Текущий код использует `Icon` и `icon`-props из `@neo-ui-kit/react`, без прямого импорта `lucide-react`. Ниже в каталоге и старых разделах spec сохранены семантические имена Lucide для назначения значков; это не названия импортируемых компонентов. Основные соответствия в текущем UI:

| Назначение / старое имя | Kit name |
| --- | --- |
| Play / Pause / Square | `play` / `pause` / `stop` |
| Settings2 / Cog | `settings` |
| AudioWaveform / RotateCcw | `wave` / `reset` |
| FolderOpen / Trash2 / Ellipsis | `folder` / `trash` / `more` |
| Plus / Search / SlidersHorizontal | `plus` / `search` / `sliders` |
| Music2 / Piano | `music` / `note` |
| Minus / Maximize2 / X | `minus` / `fit` / `close` |

Для новой кнопки выбирается существующее имя из типизированного kit API и назначения в соответствующем компоненте. Семантический словарь старых обозначений:

`AlertCircle`, `AlertTriangle`, `ArrowLeft`, `ArrowLeftToLine`, `ArrowRightToLine`, `AudioLines`, `AudioWaveform`, `BarChart3`, `Check`, `CheckCircle2`, `ChevronDown`, `ChevronLeft`, `ChevronRight`, `ChevronUp`, `CircleAlert`, `CircleCheck`, `CircleDot`, `Cog`, `Copy`, `Cpu`, `Crosshair`, `Database`, `Download`, `Ellipsis`, `FolderOpen`, `Headphones`, `Info`, `Library`, `ListChecks`, `LoaderCircle`, `Lock`, `LogOut`, `Maximize2`, `Merge`, `Mic`, `Mic2`, `MicOff`, `Minus`, `MousePointer2`, `MoveHorizontal`, `MoveVertical`, `Music2`, `OctagonX`, `Palette`, `PanelLeftClose`, `PanelLeftOpen`, `Pause`, `Piano`, `Play`, `Plus`, `Radio`, `Redo2`, `RotateCcw`, `Save`, `Search`, `Settings2`, `ShieldCheck`, `SkipBack`, `SkipForward`, `SlidersHorizontal`, `Sparkles`, `Square`, `Stethoscope`, `Trash2`, `Type`, `Undo2`, `Unlock`, `UsersRound`, `Volume2`, `VolumeX`, `Wrench`, `X`.

## 9. Иконки по основным поверхностям

### Window / shell

- `Minus` — свернуть окно.
- `Maximize2` — maximized/fullscreen toggle.
- `X` — закрыть окно/модал.
- `Cog` — открыть Settings.
- `Radio` — radio control.
- `Volume2` — уровень радио/аудио.

### Library

- `Music2` — библиотека/песня/fallback artwork.
- `Mic2` — karaoke/вокальная часть hero.
- `Plus` — добавить песню.
- `Search` — поиск.
- `SlidersHorizontal` — фильтры.
- `UsersRound` — online room.
- `Headphones` — записи/прослушивание.
- `Play` — начать karaoke.
- `AudioWaveform` — обработать песню.
- `FolderOpen` — открыть папку песни.
- `Settings2` — настройки песни.
- `RotateCcw` — повторная обработка.
- `Trash2` — удаление.
- `Ellipsis` — дополнительное меню.

### Karaoke

- `ArrowLeft` — выход/назад.
- `Play`, `Pause`, `Square` — transport.
- `SkipBack`, `SkipForward` — перемещение.
- `Minus`, `Plus` — изменения transport-параметров.
- `Mic` — microphone/mixer strip.
- `AudioLines` — audio/effects tools.
- `Type` — lyrics/display controls.
- `MousePointer2` — interaction/display tool.
- `Cog`, `SlidersHorizontal` — настройки/микшер.

### Online room

- `UsersRound` — room.
- `Copy`, `Check` — копирование room code.
- `PanelLeftClose`, `PanelLeftOpen` — свернуть/развернуть dock.
- `Mic`, `MicOff` — microphone state.
- `Volume2`, `VolumeX` — participant/room audio.
- `Sparkles` — effects.
- `Lock`, `Unlock` — effects control lock.
- `LogOut` — выйти/удалить участника по доступному сценарию.
- `ShieldCheck` — запрос microphone permission.

### Melody Editor

- `ArrowLeft` — назад.
- `Play`, `Pause` — editor playback.
- `Save` — сохранить.
- `Undo2`, `Redo2` — undo/redo.
- `Trash2` — удалить выбранное.
- `Merge` — объединение.
- `Crosshair` — позиционирование/selection focus.
- `ArrowLeftToLine`, `ArrowRightToLine` — операции по границам/позиции.
- `Piano` — переход/обозначение melody editor из song settings.

### Settings

- `Palette` — Appearance.
- `SlidersHorizontal` — Audio.
- `Cpu` — AI / Processing.
- `Wrench` — Advanced.
- `Database` — Memory/Storage.
- `ListChecks` — History.
- `Stethoscope` — Diagnostics.
- `Info` — About.
- `CheckCircle2`, `CircleAlert`, `AlertTriangle` — health/model statuses.
- `Download` — загрузка модели/ресурса.

## 10. Product identity assets

Для полноценного продукта должны существовать отдельные identity assets:

- application icon;
- Electron/window icon;
- installer icon;
- отдельный logo/wordmark asset в v1 не создаётся; название `A&D Voice` отображается текстом с канонической product typography;
- fallback participant avatar/initials treatment;
- empty Library visual treatment;
- generic error/processing visual treatment.

Если отдельная иллюстрация отсутствует, использовать согласованную композицию из kit icon + typography, а не случайные изображения из разных источников. Изображения тем и значки окна уже находятся в `src/assets/theme-icons`; перечисление identity assets не означает, что они ещё не созданы.

## 11. Title Bar content and layering

Системные кнопки title bar используют kit icons:

- `minus` — minimize;
- `fit` — войти/выйти из fullscreen (именно так работает средняя кнопка текущего TitleBar);
- `close` — close.

Эти три кнопки являются самым верхним интерактивным слоем приложения и должны оставаться поверх любых dialogs, modals, overlay и blackout surfaces.

## 12. Video audio policy

Любое karaoke video используется только как визуальный контент. Его собственная audio track не воспроизводится. Единственным источником karaoke audio timeline является `AudioService.exe`.

---

# Дополнительные обязательные UI-объекты финальной specification

Следующие семантические обозначения выбирают соответствующий kit icon, не новую SVG-библиотеку:

```text
HardDrive          → storage / insufficient disk space
MicOff             → microphone unavailable / privacy denied
ShieldAlert        → permission / compatibility warning
RefreshCw          → reconnect / retry / recovery
FileWarning        → invalid/corrupted song project
History            → performance/processing history
Crown              → room Host
UserRoundCheck     → participant Ready
WifiOff            → room/network disconnected
Download           → project/model transfer
CircleCheck        → verified / Ready / completed
CircleAlert        → failed / attention state
Trash2             → destructive delete
FolderOpen         → open managed folder
Search             → Library search
X                  → clear search / close where context-appropriate
Gauge              → latency/runtime diagnostics
Timer              → processing/recording duration
Music2             → deterministic song artwork fallback
```

Title bar system controls:

```text
minus
fit
close
```

Эти три объекта не заменяются theme-specific custom glyphs и принадлежат верхнему интерактивному слою приложения. Старое имя `Maximize2` обозначает среднюю кнопку, но её текущая команда — fullscreen toggle.
