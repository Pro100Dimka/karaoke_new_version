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

Library использует интерактивный `QuantumFieldBackdrop` — программно отрисовываемый фон. Это не статичная картинка. Лицензия исходного QFT-визуального материала находится в:

- `assets/licenses/LICENSE-QFT.txt`

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

`SongCoverArt` не требует обязательного локального image-файла. Если у песни есть artwork — показывается artwork. Если artwork отсутствует — используется fallback-композиция с Lucide `Music2`.

## 8. Lucide icon set

Все перечисленные ниже иконки используются как **объекты из `lucide-react`**, а не как вручную скопированные SVG-файлы:

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

## 10. Product identity assets to create

Для полноценного продукта должны существовать отдельные identity assets:

- application icon;
- Electron/window icon;
- installer icon;
- отдельный logo/wordmark asset в v1 не создаётся; название `A&D Voice` отображается текстом с канонической product typography;
- fallback participant avatar/initials treatment;
- empty Library visual treatment;
- generic error/processing visual treatment.

Если отдельная иллюстрация отсутствует, использовать согласованную композицию из Lucide icon + typography, а не случайные изображения из разных источников.

## 11. Title Bar content and layering

Для системных кнопок title bar использовать только Lucide objects:

- `Minus` — minimize;
- `Maximize2` — maximize/restore;
- `X` — close.

Эти три кнопки являются самым верхним интерактивным слоем приложения и должны оставаться поверх любых dialogs, modals, overlay и blackout surfaces.

## 12. Video audio policy

Любое karaoke video используется только как визуальный контент. Его собственная audio track не воспроизводится. Единственным источником karaoke audio timeline является `AudioService.exe`.

---

# Дополнительные обязательные UI-объекты финальной specification

Использовать Lucide React icons для следующих новых/уточнённых product states:

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

Title bar system controls remain exactly:

```text
Minus
Maximize2
X
```

Эти три objects не заменяются theme-specific custom glyphs и всегда принадлежат самому верхнему интерактивному слою приложения.
