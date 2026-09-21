# Карта экранов и поверхностей

## Routes

```text
/
└── Library
    ├── First Run / Empty Library
    ├── Search / Filter / Sort
    ├── Import / Add Song
    ├── Processing Queue
    ├── Recordings
    │   └── Performance Analysis
    ├── Song Settings
    │   └── /editor/:songId
    ├── History
    │   ├── Performances
    │   └── Processing
    └── Online Room

/karaoke/:songId  — режим открытия: KaraokeOpenMode { Normal | AutoStart | RoomPrepared }
└── Karaoke
    ├── Preparing
    ├── Ready
    ├── Playing
    ├── Paused
    ├── Recovering Audio
    ├── Finished
    ├── Failed
    ├── Performance Stage
    │   ├── Song Video / Scene Video / Theme Background
    │   ├── Lyrics
    │   ├── Piano Roll
    │   └── Live Pitch
    ├── Console
    │   ├── Transport
    │   ├── Practice Speed
    │   ├── Key Transpose
    │   ├── Mixer
    │   ├── Song Strip
    │   └── Tools
    └── Room Dock when room is active

/editor/:songId
└── Melody Editor
    ├── Loading
    ├── Invalid/Version-incompatible Project
    ├── Timeline / Zoom / Scroll
    ├── Words / Notes
    ├── Selection / Multi-selection
    ├── Playhead / Follow
    ├── Undo / Redo
    ├── Dirty State
    ├── Recovery Draft
    └── Save / Restore / Conflict States
```

## Global overlays

```text
Settings
├── Appearance
├── Audio
│   ├── Input / Output / Backend / Sample Rate / Period (Runtime под ⓘ)
│   ├── Input Test (switch) + Live Input Level (waveform)
│   ├── Microphone Volume (rotary knob)
│   ├── Test Output
│   └── Estimated Latency + Health
├── AI / Processing
│   └── Model Download States
└── Advanced
    ├── Memory / Storage
    ├── History
    ├── Diagnostics
    └── About

Online Room Dock
Transient Notifications
Global Alert / Confirm Dialogs
Route Blackout
Desktop Title Bar System Controls
```

## Product states that can surface globally

```text
Python Backend Unavailable / Reconnecting / Protocol Incompatible
AudioService Unavailable / Recovering / Protocol Incompatible
Insufficient Disk Space
Windows Microphone Permission Denied
Recovered/Incomplete Recording
Interrupted Processing Job
Recovered Melody Editor Draft
```

## Layer priority

```text
Route Content
< Route Popovers / Menus
< Global Dock / Floating Controls
< Settings / Standard Modals
< Confirmation / Critical Dialogs
< Transition Blackout Visual Layer
< Desktop Title Bar System Controls
```

`Minus`, `Maximize2`/Restore и `X` всегда находятся поверх всех modal/overlay surfaces и остаются кликабельными, включая Karaoke fullscreen.

Modal backdrops и focus traps не имеют права перехватывать pointer activation этих системных кнопок.

## Visibility matrix

| Surface | Library | Karaoke | Melody Editor |
|---|---:|---:|---:|
| Title Bar system buttons | yes | yes, including fullscreen | yes |
| Floating Radio | yes | no | no |
| Floating Settings | yes | no | no |
| Online Room Dock | if room active | if room active | hidden while editing |
| Settings Modal | yes | yes | no while editor owns blocking edit dialog |
| Quantum Field | yes | no | no |
| Karaoke Scene Background | no | yes | no |
| Live Pitch | no | only with microphone + compatible project | no |
| Monitoring controls | no | only with available microphone | preview-specific only |


## State ownership visible from screens

```text
Library cards / Processing Queue / History
→ Python Backend authoritative state

Karaoke transport / Audio Settings / Recording / Mixer / live room audio
→ AudioService authoritative state

Window controls / File and Folder dialogs / native Windows actions
→ Electron Main authoritative execution

Open modal / selected tab / hover / local form draft
→ React presentation state
```
