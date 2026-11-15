# Karaoke video startup and controls, 2026-11-15

## Cause and change

The introduction released audio when the native session was prepared, independently of the song video's readiness. With the clip response delayed by 6500 ms through CDP, the previous renderer left the introduction and reached 0:01 while the video still had readyState 0.

The song video's canplay event now releases the solo introduction. A cached-ready element is also recognized. Unsupported or failed clips fall back to the existing background instead of holding the introduction. The RoomPrepared path retains its existing release condition and server timeline.

Browser readiness semantics: [MDN readyState](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState), [MDN canplay](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canplay_event).

## Manual CDP evidence

- Development Electron window, port 9230, actual local NeAngely clip, rehearsal mode.
- After the fix, with the same 6500 ms response delay, the introduction remained visible and elapsed time stayed 0:00 while readyState was 0.
- Video canplay occurred at 8337.6 ms; video playing at 10765.4 ms, after the existing 2400 ms announcement hold.
- Aborting the song clip request released the introduction with the existing scene:// fallback; elapsed time advanced to 0:01.
- No automated test suite was added or run. No song processing, mastering or recording job was started. Room playback was not exercised.
- Renderer and Electron type checks, architecture check and production renderer build passed. The build retains the existing large-chunk warning.

## Controls

Hide and restore are icon buttons with accessible labels, without visible text. Hide uses a minus icon on the console's upper border. Its opaque theme background and z-index above the animated border prevent the border from crossing the icon. Restore uses a window icon centered on the screen edge corresponding to the console's dock. The library action is a compact pill in the title bar, replacing the large floating round button.

Hide and restore were exercised at all four dock edges. At 1920 x 1080 the horizontal button center was x 960 and the vertical button center was y 540. At 1024 x 768 the bottom restore button was centered at x 512 (x 497, y 730, size 30 x 30). Red and light themes were inspected. The original red theme and bottom dock were restored.

- [Console, red](console-red.jpg)
- [Console, light](console-light.jpg)
- [Restore, red](restore-red.jpg)
- [Restore, light](restore-light.jpg)
- [Library action](back-red.jpg)
- [Timing diagnostics](diagnostics.json)
