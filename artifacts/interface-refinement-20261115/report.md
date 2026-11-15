# Interface refinement, 2026-11-15

Restored the UI kit's pill radius for action buttons and circular radius for icon buttons. Kept the original round playback controls.

Removed the oversized planet from the karaoke introduction. The introduction now has an opaque black base and a soft theme accent. Moved the library shading to the whole route surface so its title-bar area shares the same background.

Analysis uses content height with a viewport limit. Reduced the header artwork and removed nested player frames. The listening workspace is shorter, with one outer frame and a quiet divider around the waveform.

Audio settings use three equal columns on wide screens, with the driver above the sample-rate and buffer fields. Removed the fixed empty height from settings. Song settings have theme-aware media surfaces, an action divider and a secondary folder button. Completed queue entries use quiet borders and step indicators; active tasks retain their emphasis.

## Verification

- Actual development Electron window, CDP port 9230, renderer served by Vite.
- Red, light, green and violet themes inspected through the settings UI.
- Existing recording, successful analysis, song settings, audio settings, processing queue and karaoke introduction inspected.
- At 1024 x 768, the listening dialog had no horizontal overflow; analysis actions remained within the viewport (bottom 713.6 px).
- Button radius measured at 15984 px, the UI kit's pill token.
- TypeScript renderer and Electron checks passed. Architecture check passed. Production renderer build passed, retaining the existing large-chunk warning.
- No automated tests were added or run. No recording, mastering or song-processing job was started. The existing failed-analysis state was not retriggered.
- No room audio or synchronization changes.

## Screenshots

- [Listening, red](listening-red.jpg)
- [Listening, 1024 px](listening-1024.jpg)
- [Analysis, red](analysis-red.jpg)
- [Audio, red](audio-red.jpg)
- [Audio, light](audio-light.jpg)
- [Audio, green](audio-green.jpg)
- [Song settings, light](song-light.jpg)
- [Queue, violet](queue-violet.jpg)
- [Karaoke introduction](intro-red.jpg)
- [Library background](library-red.jpg)
