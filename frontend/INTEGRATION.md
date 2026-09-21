# Frontend integration

The frontend now connects to the existing Python Backend and AudioService without changing either service.

## Process ownership

Electron Main starts and supervises both processes:

- Python: `python -m backend.main` from `../python`
- AudioService: `AudioService.exe`

Environment overrides:

- `AD_VOICE_PYTHON` — Python executable
- `AD_VOICE_AUDIO_SERVICE` — full path to `AudioService.exe`
- `AD_VOICE_DATA` — Python managed data root
- `AD_VOICE_PORT` — Python HTTP port, default `8765`

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

Electron proxies HTTP calls to `http://127.0.0.1:<AD_VOICE_PORT>` so the renderer does not need CORS changes in the Python Backend.

## AudioService

Electron connects to the existing pipe:

```text
\\.\pipe\ADVoice.AudioService.v1
```

using the existing protocol version `1` and existing command names.

## Project audio

No Python endpoint was added. For prepared songs the Electron integration reads the existing managed project manifest under the same `AD_VOICE_DATA` root and resolves the existing `instrumental` / `referenceVocal` artifacts before issuing `LoadSong`.

## Recording

The existing contracts are connected as designed:

1. `POST /recordings/target`
2. `PrepareRecording`
3. `StartRecording`
4. `StopRecording`
5. inspect finalized WAV header
6. `POST /recordings`

No recording behavior was added to Python or AudioService.
