# Radio foreground handoff

Date: 2026-11-15

## Reproduction

Played the original song in the analysis dialog through CDP, paused it, then invoked station preparation as a diagnostic. Before the change, AudioService rejected LoadRadioStation with `Radio cannot replace an active foreground media context`. The application reported the generic station-unavailable message. No processing job was needed to reproduce this conflict.

## Change

Loading a station prepares its media slot without taking the foreground context. Starting radio releases recording-preview ownership and stops that preview before PlayRadio. The native protection against replacing karaoke or editor playback remains in place.

## Verification

- Rebuilt and restarted the working application with CDP on port 9230.
- Repeated the diagnostic: station preparation reached RadioState 2 while the original preview remained paused (PreviewState 4). Starting radio reached RadioState 3, unloaded the preview (PreviewState 0), and cleared preview ownership.
- Used the rendered radio controls to change station, pause and resume. Final state: enabled true, error false, RadioState 3.
- Temporarily enabled the renderer's localProcessing flag: radio remained enabled, error false and RadioState 3. Restored the flag afterward. This checks state handling, not sustained playback under a real processing workload; no song-processing job was launched.
- Restored the original station and paused radio after verification.
- Frontend typecheck and architecture passed. AudioService and its existing native test target compiled successfully. Automated tests were not executed.
- Updated existing preview-ownership and media tests; no new test functions or files were added.
