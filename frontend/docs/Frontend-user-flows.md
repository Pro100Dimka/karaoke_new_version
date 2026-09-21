# Основные пользовательские сценарии

## 1. Первый запуск

```text
Open application
→ Bootstrap Electron / Python backend / AudioService
→ Check protocol compatibility
→ Validate persisted audio configuration
→ Validate storage/model state
→ Library loads
→ User sees songs or First Run state
→ User can Add Song / Configure Audio / Download required models
```

## 2. Добавить песню

```text
Library
→ Plus / Drag & Drop
→ Select file
→ Validate readable format / duplicate / free disk space
→ Show filename + detected metadata fallback
→ Confirm import
→ Importing + progress
→ Song appears in Library
→ Process if required
```

Cancel during import:

```text
Importing
→ Cancel Import
→ Remove incomplete managed copy
→ Return to Library state
```

## 3. Обработать песню

```text
Song Card
→ Process
→ Storage/model preflight
→ Processing Queue
→ Queued
→ Preparing
→ Processing stages + progress
→ Completed
→ Refresh automatic metadata while preserving manual overrides
→ Card becomes Ready
```

Cancel running job:

```text
Processing
→ Cancel
→ Cancelling
→ Current non-interruptible stage finishes safely
→ No next stage starts
→ Cancelled
```

Failed:

```text
Processing Failed
→ Error details
→ Retry / Reprocess / Close
```

## 4. Настроить audio

```text
Settings
→ Audio
→ Select Input / Output / Backend / Sample Rate / Period
→ каждое изменение сохраняется и сразу применяется AudioService
→ значения Runtime и Estimated Latency видны под ⓘ и в строке Latency
→ включить Input Test (мониторинг + живая волна) / повернуть Microphone Volume / Test Output
```

Закрытие Settings (`X`, `Esc`, click outside, app close):

```text
→ Input Test и мониторинг выключаются автоматически
→ подтверждений нет: все настройки уже сохранены
```

## 5. Запустить local karaoke

```text
Ready Song Card
→ Play
→ /karaoke/:songId
→ KaraokeOpenMode = Normal (обычный запуск из Library) / AutoStart (явно запрошенный немедленный старт) / RoomPrepared (переход из подготовленной room session)
→ Validate projectFormatVersion / project integrity
→ Preparing
→ AudioService session prepared
→ Ready
→ Play
→ Playing
```

Without microphone:

```text
Playback / Lyrics / Piano Roll / Video remain available
Monitoring / Live Pitch / Voice Recording are disabled
```

## 6. Practice controls

Before recording:

```text
Practice Speed = 0.50 / 0.65 / 0.75 / 0.85 / 1.00
Key Transpose = -12 ... +12 semitones
Vocal Range Display = visual range only
```

During active recording, Practice Speed / Key Transpose / Seek are locked.

## 7. Завершить karaoke

```text
Song reaches EOF
→ Stop active recording automatically
→ Finalize recording
→ Karaoke enters Finished
→ Repeat / Library / Recording / Analysis when result exists
```

## 8. Записать выступление

Запись автоматическая: отдельной кнопки записи нет, она стартует при воспроизведении, если микрофон готов.

```text
Karaoke
→ Play (microphone ready)
→ Check free disk space
→ Start Recording automatically
→ Recording active
→ Seek / Speed / Key locked
→ Perform
→ Stop or EOF
→ Finalization
→ Recording saved as Take
→ Recording actions available
```

## 9. Посмотреть запись и анализ

```text
Library / Karaoke Finished / History
→ Recordings
→ Select Take
→ Playback
→ Rename / Open Folder / Delete / Open Analysis
```

## 10. Редактировать мелодию

```text
Song Settings
→ Melody Editor
→ Validate project version/integrity
→ Load project
→ Select / multi-select / move / resize / merge notes
→ Zoom / scroll / pitch range / playhead follow
→ Preview playback
→ Undo / Redo
→ Save
→ Back
```

Unsaved exit:

```text
Back / Close / Another Song
→ Save / Discard / Cancel
```

Crash recovery:

```text
Recovered editor draft detected
→ Restore Draft / Discard
```

## 11. Создать online room

```text
Library
→ Online Room
→ Create Room
→ User becomes Host
→ Room Code
→ Dock appears
→ Copy code
→ Participants join
```

## 12. Войти в room

```text
Library
→ Online Room
→ Join Room
→ Enter room code
→ Validate room/version/capacity
→ Participant list
→ Resolve microphone privacy/device state
```

## 13. Подготовить песню в room

```text
Host selects song
→ Clients check local compatible project
→ Missing Song
→ Host prepares project package
→ Downloading + progress
→ Verify checksum/project version
→ Preparing Audio
→ Ready
```

Host sees readiness of every participant.

## 14. Запустить karaoke в room

```text
All remaining participants Ready
→ Host selects Practice Speed + Key Transpose
→ Countdown
→ Parameters lock
→ Authoritative room start time/position distributed
→ Each AudioService starts local playback against room timeline
→ Remote voices mixed locally
```

After countdown, room Seek is locked until Stop/Finish; Host retains Play/Pause/Stop authority.

## 15. Late Join

```text
Participant joins active room
→ Receive room snapshot
→ Resolve/transfer current project
→ Prepare Audio
→ Sync to current room playback position
→ Join current performance
```

## 16. Room reconnect

```text
Network disconnect
→ Reconnecting
→ Connection restored
→ Fetch authoritative room snapshot
→ Restore participant state
→ Flush stale remote media
→ Resync song position
```

## 17. Host disconnect

```text
Host disconnects unexpectedly
→ 10-second grace period
→ Host returns: keep authority
OR
→ oldest connected participant becomes Host
OR
→ room closes when nobody remains
```

## 18. Device lost during Karaoke

```text
Audio device lost
→ Recovering Audio
→ AudioService same-device recovery/reconfiguration
→ Reload actual Runtime state
→ Karaoke returns Paused
→ Audio recovered: Resume / Stop / Audio Settings
```

Playback never resumes automatically after AudioService recovery.

## 19. AudioService disconnect

```text
AudioService disconnect
→ Live audio controls disabled
→ Recovering Audio state
→ Electron restarts/reconnects according to lifecycle policy
→ Reload actual state
→ Resume only after explicit user action
```

## 20. Python backend reconnect

```text
Python unavailable
→ Library/data actions unavailable
→ Retry connection
→ Reconnect
→ Refresh Library / Processing Queue / History / Models / Storage authoritative snapshots
```

## 21. Model download

```text
Settings → AI / Processing
→ Missing model
→ Check required/available disk space
→ Download
→ Progress / Cancel
→ Ready
```

Failure:

```text
Download failed
→ Error details
→ Retry / Cancel
```

## 22. Invalid/old song project

```text
Open song
→ Validate projectFormatVersion + required artifacts
→ Compatible: continue
→ projectFormatVersion ниже минимально поддерживаемой версии: Reprocess / Upgrade Project
→ Newer unsupported: Update Application required
→ Corrupted: Project Invalid → Repair/Reprocess
```

## 23. Delete song

```text
Song Actions
→ Delete
→ Confirmation shows generated project + recordings count
→ Confirm
→ Remove Library record + managed source/project/cache + recordings/analysis
→ Never delete external original source file
```

## 24. Закрытие приложения

```text
Close button (always available above modals)
→ Check dirty Settings / Editor / active Recording / active Processing / active Room
→ Resolve Save/Apply/Finalize/Cancel confirmations
→ Cancel queued/running processing safely when user chose exit
→ Leave/close room
→ Stop AudioService session
→ Shutdown services
→ Close window
```

## 25. Previous crash recovery

```text
Next startup
→ Query recovery state
→ Show Recovered Recording / Interrupted Processing / Editor Draft notifications
→ User explicitly resolves each recoverable item
→ Previous room is not auto-rejoined
```

## 26. Diagnostics support

```text
Settings → Diagnostics
→ Review live health
→ Copy Diagnostics or Export Report
→ Report contains app/backend/AudioService state without user audio content
```


## 27. Канонический routing live audio

```text
React control
↓
Preload/Electron Main
↓
AudioService control IPC
↓
Realtime AudioService state
↓
State/diagnostics snapshot back to React
```

Python Backend не находится между React и AudioService для `Play`, `Pause`, `Seek`, monitoring, mixer, live effects или recording execution.

## 28. Канонический routing offline processing

```text
React
↓
Python Backend
↓
Processing queue / AI / project build
↓
Authoritative processing snapshot
↓
React
```

AudioService не исполняет offline song processing pipeline.

## 29. Open Folder / File Picker / Windows action

```text
React
↓
Preload
↓
Electron Main
↓
Windows native action
```

Renderer не получает прямой filesystem или process access.
