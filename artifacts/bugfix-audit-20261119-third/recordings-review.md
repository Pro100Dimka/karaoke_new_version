# Third-pass recording player audit — 2026-11-19

## Delivered scope and source freeze

Base commit: `9d44f17dfa7fbc321c5dc8e8c8a722e9e511cfaf` on `fix/app-bugs-excluding-processing-20261119`.

Only these three source/test files remain changed by this agent:

- `frontend/src/services/audioPlayers.ts`
- `frontend/src/services/audioPlayers.test.ts`
- `frontend/src/pages/library/modals/recordings/RecordingPlayer.interactions.test.tsx` (new)

Source is frozen after the final focused checks. No commit, push, pull request, or full suite was run by this agent.

The user's newer instruction excludes the editor. All editor source edits from this pass were restored to HEAD and the new editor interaction test was deleted. `git status --short` and `git diff --stat` for both `frontend/src/pages/editor` and `frontend/src/application/editor` are empty. Earlier committed editor changes were preserved. The intermediate `third-editor-drag-*` logs are excluded work, not delivered fixes or verification of this patch.

Processing, separation, ASR, alignment, pitch/DSP algorithms, recording algorithms, analysis, studio and AD Master implementation/configuration/tests were not edited.

## Confirmed ordinary-use defect: visible mute ignored while a recording loads

Reproduction: open a ready saved recording, click Play, then turn its visible volume knob to zero before loading finishes. This is possible while recording metadata is being fetched and while AudioService is preparing the preview.

Before the correction the UI showed volume zero but the command immediately preceding `PlayRecordingPreview` was `SetGain {target: 'preview', value: 1}`. Thus playback started at the original full volume despite the visible mute.

Call path: the actual `RecordingPlayer` renders the actual Neo `RotaryKnob`; its `onValueChange` reaches the actual `useRecordingPlayback.changeVolume`, then `createAudioPlayers.setPreviewVolume`. While metadata loads, the new owner has not yet become `previewOwner`, so the setter silently returns. While native readiness is pending, a volume command can be sent, but `playPreview` later overwrites it with the `gain` value captured at the original Play click.

Correction: remember the requested gain together with the pending preview owner. Updates from that owner change the pending value. Immediately before Play, the current request applies the latest value; subsequent changes use the normal owned-preview route. Cancellation, replacement and failed requests retire their pending volume. The existing preview-generation check protects the transition to gain application. No audio processing was changed.

## Actual RED and focused GREEN

The new integration test keeps the actual RecordingPlayer, volume knob, playback hook and preview service; only external metadata/native operations and waveform acquisition/telemetry are replaced. It tests muting during both metadata and native-readiness waits. The two tests failed before source edits because the command value was 1 instead of 0:

- `third-editor-player-volume-red.log`: **2 expected failures**.

The service ownership regression additionally checks that muting a pending player does not mute the currently active other player; the active player can still change its own volume, and cancelling the pending player does not leak its zero gain into a subsequent play.

After the final source and test edits and formatting:

- `third-editor-player-final.log`: **4 files, 22 tests passed**. Files: RecordingPlayer.interactions, useRecordingPlayback, RecordingCard.memo, audioPlayers.
- `third-editor-types.log`: `tsc -b tsconfig.app.json --pretty false`, **exit 0**.
- `third-editor-architecture.log`: **Architecture check passed**, exit 0.
- `git diff --check` for the three scoped files: **exit 0**.

`third-editor-player-volume-green.log` records the earlier targeted green run; the final log supersedes it for the frozen source.

## Read-only coverage and rejected hypotheses

Read the recordings list and player UI, recording cards, useSongRecordings load/open/rename/delete flow, useRecordingPlayback, audioPlayers ownership and loading flow; traced delete to the backend delete use case read-only. The delete use case deletes only the selected take, so a speculative automatic cascading deletion/list mismatch was not promoted to a defect. Existing selected-recording fallback and loading seek-ownership behavior were retained.

Read karaoke page navigation/loading/error UI, transport button enabling, shortcut focus ownership, relevant control dispatch and audioClient prepare/play/pause/seek/stop contracts. No new confirmed karaoke defect was delivered. Unconfirmed ideas about loading navigation and keyboard/dialog escape were not changed. Editor review stopped and was reverted when the user excluded it.

The new tests exercise real rendered controls in jsdom, not Electron or a real browser rendering/audio session. Root reported Chromium could not launch because this environment rejects Unix sockets. No claim of visual/live playback validation is made. The Windows `start.bat` live check and actual audible mute-before-ready playback remain pending outside this environment. The required two-window `start-multy.bat` room/device gates were not run and are not claimed.
