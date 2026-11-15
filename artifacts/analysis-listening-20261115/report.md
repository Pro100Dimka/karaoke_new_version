# Analysis listening controls

Date: 2026-11-15

## Changes

- Original song player above the source and mastered recording cards.
- Folder actions beside recording deletion, plus a folder action for the original song.
- Shared native preview ownership prevents simultaneous playback of these players.
- Removed visible volume captions and the separator beside the knobs; accessible labels remain.
- Theme-aware wave meters with a subtle tick ruler replace the plain metric bars.

## Verification

- Checked the working renderer through CDP on port 9230 in red, light, green and violet themes.
- Original playback and waveform seek worked. Switching to the source recording and then the master transferred preview ownership and stopped the previous player.
- The master folder action completed. Opening Explorer also produced an audio-session focus warning in the ASIO configuration; device focus recovery was not changed or verified by this work.
- At 1024 by 768, the dialog scrolls vertically and its footer remains available. No horizontal overflow was observed.
- Frontend TypeScript, frontend architecture, backend architecture, scoped Ruff and scoped mypy passed. Backend architecture retains existing file-size warnings.
- Existing regression cases were updated for the source path and shared preview behavior. No new tests were added. Automated test suites were not run for this task.

## Screenshots

- [Red](red.jpg)
- [Light](light.jpg)
- [Green](green.jpg)
- [Violet](violet.jpg)
- [Compact violet](violet-compact.jpg)
