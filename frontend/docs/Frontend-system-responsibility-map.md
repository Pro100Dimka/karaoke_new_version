# Карта ответственности систем A&D Voice

> Карта описывает границы существующих подсистем. Обязательная серверная архитектура комнаты и её live-проверки определены в корневом `AGENTS.md`.

Этот документ является частью описания проекта и фиксирует, какая часть продукта фактически исполняет каждую функцию.

## Frontend technology

```text
React + TypeScript + Electron + Vite + @neo-ui-kit/react
```

Production renderer/preload/application contracts пишутся на TypeScript. JavaScript не используется как параллельная implementation path нового frontend.

## React Renderer

React отвечает только за UI/presentation:

```text
routes
screens
layout
forms
buttons
lists/grids
lyrics rendering
piano-roll rendering
pitch visualization
editor interactions
modal/dialog/notification presentation
loading/error/empty/recovery presentation
theme/i18n/accessibility
```

React не является владельцем realtime audio, long-running processing, native window/process lifecycle или filesystem.

## Electron Main / Preload

Electron Main отвечает за desktop/system bridge:

```text
window lifecycle
minimize/maximize/restore/close/fullscreen
file picker/folder picker
open/reveal folder
clipboard/native desktop actions
launch/monitor/stop AudioService.exe
launch/monitor/stop Python backend where packaging requires it
AudioService control IPC
safe backend bridge
OS settings/permissions bridge
keyboard-lighting/native Windows bridge
local scene-media URL bridge
```

## Python Backend

Python отвечает за offline/data domain:

```text
library
song metadata
SQLite/data
import registration
offline song processing
offline AI/ML processing
processing queue/status
project generation/validation/version
Melody Editor document persistence
recording metadata/history
performance analysis
storage/cache management
AI models
room control/signaling/auth/session metadata
```

## AudioService.exe

AudioService отвечает за весь live/realtime audio domain:

```text
audio-device discovery
WASAPI/ASIO
runtime audio configuration
microphone capture
song playback
play/pause/seek
authoritative local playback timeline; room playout follows the server timeline
monitoring
mixer
live DSP
resampling/format conversion
recording realtime path + audio-file writing
radio playback
editor audio preview
remote media encode/decode
network jitter buffer
remote voice playback
clock synchronization/drift correction
output routing
live latency/diagnostics
recovery/reconfiguration
```

## Канонический routing пользовательских действий

```text
Play / Pause / Seek
React → Electron Main → AudioService

Monitoring / Mixer / Live Effects
React → Electron Main → AudioService

Start / Stop Recording
React → Electron Main → AudioService

Audio Device Settings
React → Electron Main → AudioService

Import / Process / Reprocess
React → Python Backend

Library / History / Project Save
React → Python Backend

Create / Join Room / room-control metadata
React → Python Backend

Remote realtime voice media
AudioService → Room Server → per-recipient server mix-minus → AudioService

File Picker / Open Folder / Clipboard / Window Controls
React → Electron Main
```

## Room Server

Сервер задаёт музыкальную шкалу и срок воспроизведения, принимает timestamped microphones, выравнивает допущенные удалённые голоса и возвращает каждому участнику mix-minus. Собственный обработанный микрофон исполнитель слышит локально. Опоздавшие пакеты не проигрываются позднее; deadline не увеличивается во время песни. Эта архитектура не заменяется локальным смешиванием голосов участников.

## Запрещённые параллельные пути

Границы подсистем не допускают:

```text
React AudioContext as main audio engine
React getUserMedia monitoring path
WebAudio mixer for karaoke
Python microphone capture
Python live monitoring
Python live mixer
Python realtime recording path
Python remote voice renderer
React filesystem access
React child-process management
React direct named-pipe access
```

## Authoritative state

```text
Library / processing / song project
→ Python Backend

Playback / microphone / mixer / recording / runtime devices / remote media
→ AudioService.exe

Desktop window / process/native integration
→ Electron Main

Presentation-only state
→ React Renderer
```
