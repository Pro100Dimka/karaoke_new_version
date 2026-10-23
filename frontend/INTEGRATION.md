# Frontend integration

The frontend connects to separate Python Backend and AudioService processes. This describes the current integration; it is not a claim that all runtime or room gates have passed.

## Working launch and verification

Run `start.bat dev` from the repository root for renderer hot reload, or `start.bat` for the bundled application. Close an existing application normally before switching modes. `check.bat frontend` runs the full frontend checks; `check.bat all` runs the three subsystem suites. Room scenarios use `start-multy.bat` and the mandatory live gates in the root `AGENTS.md`.

## Process ownership

Electron Main starts and supervises both processes:

- Python: `python -m backend.main` from `../python`
- AudioService: `AudioService.exe`

Environment overrides:

- `AD_VOICE_PYTHON` — Python executable
- `AD_VOICE_AUDIO_SERVICE` — full path to `AudioService.exe`
- `AD_VOICE_DATA` — Python managed data root
- `AD_VOICE_PORT` — Python HTTP port; Electron defaults to `0` (OS-assigned), standalone Python defaults to `8765`
- `AD_VOICE_AUDIO_ENDPOINT` — AudioService pipe override; the default is shown below

Electron chooses the data root from the saved storage setting, then `AD_VOICE_DATA`, then `userData/backend-data`. The managed backend announces its actual endpoint; see `electron/ManagedServices.ts`, `AppPaths.ts` and `BackendEndpoint.ts`.

If `AD_VOICE_AUDIO_SERVICE` is not set, Electron looks in:

1. `../AudioService/build/Release/AudioService.exe`
2. `../AudioService/build/AudioService.exe`
3. `<resources>/audio-service/AudioService.exe`

## Transport

```text
React
  ├─ PythonClient -> preload -> Electron Main -> HTTP -> Python Backend
  └─ AudioServiceClient -> preload -> Electron Main -> Windows Named Pipe -> AudioService.exe
```

The renderer never gets Node.js, raw `ipcRenderer`, filesystem or named-pipe access.

## Python

Electron proxies HTTP calls to the discovered loopback backend endpoint, so the renderer does not need raw HTTP/filesystem access. Do not assume the managed backend always listens on port `8765`.

## AudioService

Electron connects to the existing pipe:

```text
\\.\pipe\ADVoice.AudioService.v1
```

using the existing protocol version `1` and existing command names.

## Project audio

For prepared songs Electron validates the requested song/revision and reads the managed manifest to resolve `instrumental`, `referenceVocal` and optional `melodyReference` artifacts before issuing `LoadSong`. AudioService owns playback position; lyrics, video and notes follow that position.

Waveform peaks are actual media data, not generated decoration. Electron reads published instrumental WAV peaks off the renderer thread. Before that artifact exists it falls back to `GET /songs/{id}/waveform?bins=…`, where Python/FFmpeg decodes the managed source (including MP3/FLAC). The renderer receives numeric peaks and never decodes audio. Missing peaks leave an empty waveform rather than invented bars.

`Уточнить слова и ноты` requests the backend's `lyrics` reprocess using existing stems, text and phrase hints. A new immutable revision is published and loaded. Manual edits cause `ManualLyricsConflict`; the queue exposes an explicitly confirmed reset to AI baseline and retry, preserving earlier revisions.

## Recording

Playback starts recording automatically when the microphone is ready. The main recording flow is:

1. `POST /recordings/target`
2. `PrepareRecording`
3. `StartRecording`
4. `StopRecording`
5. inspect finalized WAV header
6. `POST /recordings`

AudioService writes the performance WAV; Python validates and registers the result, tracks recovery and performs offline analysis/mastering. Recording finalization and metadata registration are separate steps, so recovery must handle a file saved before registration succeeds.

Studio Master creates another WAV linked by `sourceRecordingId`; the recordings UI groups it with its original take. It retains the recorded wet performance mix and supplements the separated vocal only as needed before mastering, rather than replaying the current Karaoke effects settings. Live monitoring and recording remain AudioService responsibilities.

## Room boundary

The required room architecture has Room Server own the musical timeline/deadline and return an aligned per-recipient mix-minus. Clients render the local project at the server position and monitor their own processed microphone locally. See `AGENTS.md` for the complete fixed-deadline, late-packet and real-window/microphone verification requirements. Local IPC or simulated-network tests alone do not establish room completion.
