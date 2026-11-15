# Intro readiness and restore control, 2026-11-15

The previous release condition recognized playable media data. Solo introduction readiness now additionally waits for a presented video frame, using the existing video element. Previously displayed cached frames are recognized through playback-quality counters; pending frame callbacks and event listeners are removed when the source changes.

API semantics: [video frame callback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [displayed and dropped frame counters](https://developer.mozilla.org/en-US/docs/Web/API/VideoPlaybackQuality/totalVideoFrames).

The restore icon button is 44 x 44 px with a mixer/sliders icon, centered on its dock edge. It receives the same activity visibility state as the library action. Both fade during playback after inactivity and return on pointer activity. The hide button remains a minus icon on the console border.

## Manual CDP checks

- Actual development Electron renderer, CDP 9230, NeAngely clip, rehearsal mode.
- Clip response delayed by 6500 ms: the intro covered the full 1920 x 1080 viewport at opacity 1; its card occupied the center, video readyState was 0, and elapsed time stayed 0:00.
- After media readiness and first-frame delivery, the intro completed and playback advanced. A repeated cached launch also completed without a stuck intro.
- Restore control measured 44 x 44 px, center x 960 on a 1920 px viewport.
- After 2800 ms without pointer activity, both restore and library actions had opacity 0. Pointer movement returned both to opacity 1.
- Renderer and Electron type checks, architecture check and production renderer build passed. The existing large-chunk build warning remains.
- No automated tests were added or run. Room playback was not exercised; the server-scheduled room release condition was not changed.

[Waiting intro screenshot](waiting-intro.jpg), [restore control](restore.jpg), [diagnostics](diagnostics.json).
