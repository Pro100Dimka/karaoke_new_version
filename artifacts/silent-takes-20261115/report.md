# Silent solo take admission, 2026-11-15

The performance file includes accompaniment, so nonzero duration alone cannot establish that the user contributed microphone audio.

The solo recording coordinator now observes the existing local microphone activity frames while capture is running. A take is considered a discard candidate only when microphone observations explicitly reported inactivity and native capture has no overruns, gaps or dropped gap metadata. Pitch accuracy and note scores are not used. Missing or uncertain observations preserve the take.

Before admitting such a take to the library, the backend independently checks the complete stopped dry microphone stem in bounded blocks. Any sample above 0.0001 full scale, invalid/unavailable stem, incomplete capture, unexpected files or active file writer prevents automatic cleanup. A refused silent cleanup falls back to normal registration. Already registered recordings are protected from this cleanup mode.

This is conservative silence detection, not a general singing-versus-noise classifier. Audible ambient input can therefore preserve a take. Existing recordings are not scanned or removed. Room recordings retain their previous behavior.

## Verification

- Updated the existing zero-frame lifecycle test to also cover a nonzero-duration take with explicitly inactive microphone observations. No new test file or test case was added.
- Automated test suites were not run.
- Renderer and Electron type checks, frontend architecture check and production renderer build passed. Existing large-chunk warning remains.
- Scoped Python Ruff, syntax and mypy checks passed.
- A live microphone recording and automatic file cleanup have not yet been exercised. No live room verification was performed because room admission behavior was left unchanged.
