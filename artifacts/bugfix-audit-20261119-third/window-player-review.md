# Root review: startup/error window controls and preview ownership

## Frameless error screens

`frontend/electron/MainWindow.ts` creates the main window with `frame: false`. The application's normal title bar is owned by AppShell. BootstrapGate's unavailable/incompatible screen and ErrorFallback replace that shell, so they previously offered no visible close/minimize/fullscreen controls.

Actual component tests were added before product edits. BootstrapGate produced two expected failures (unavailable and incompatible) and one passing recovery control. ErrorFallback produced one expected failure for the missing window toolbar. Existing real Neo UI components are used; desktop IPC is a mocked boundary. Audio setup hooks are stubbed in the gate test to keep the scenario about the startup screen rather than DSP.

The fix renders the existing TitleBar on each error screen. BootstrapGate hands ownership back to the normal shell when Python becomes ready. Its regression checks exactly one toolbar after recovery. The existing parent App retains the close-request subscription above both the gate and error boundary.

Final focused command from frontend:

```sh
node_modules/.bin/vitest run src/app/BootstrapGate.test.tsx src/providers/error-boundary.test.tsx src/app/useWindowState.test.tsx --maxWorkers=1
```

Result: 3 files / 5 tests passed, exit 0. Raw evidence: `third-bootstrap-red.log`, `third-error-window-red.log`, and `third-window-green.log`. A separate reviewer traced the modal/popover/window listener cleanup; see `window-independent-review.md` in the published report.

## Independent review of the recording preview change

Read the full createAudioPlayers lifecycle and the new real RecordingPlayer/RotaryKnob regression. The pending gain belongs to the pending owner's request object. An obsolete request is rejected by the generation guard before it can clear/apply the current pending value. Active and pending owners are distinct; changing the pending volume does not send a gain command to the currently playing other take. Cancellation clears the pending value. After readiness, the latest gain is applied before Play, and later changes follow the ordinary active-owner path.

The additional service regression proves active-owner isolation and cancellation. No DSP, capture, mixing or recording algorithm is changed. No actionable new regression was found in this scoped review.

## Live execution limits

A real Playwright/Chromium renderer probe was attempted using `/usr/bin/chromium` with a disposable headless browser. It failed before any page opened: Chromium process singleton could not create an AF_UNIX socket (`socket() failed: Operation not permitted (1)`). The following observed error was returned by the execution tool, not by an application assertion:

```text
FATAL:chrome/browser/process_singleton_posix.cc:297 Check failed: . socket() failed: Operation not permitted (1)
```

The raw browser-launch output was not saved to a file at the time; this is a recorded excerpt of the observed tool output, not a fabricated full log. No screenshot or live browser result is claimed. The root did not attempt to bypass the environment restriction.

Component tests run in jsdom. They do not verify actual native window IPC, pointer hit testing, layout, dialog top-layer inertness, audible playback, or hardware. Windows start.bat verification of the two error screens and muted preview remains pending. The separate room changes additionally require the real two-window start-multy.bat gate.

## Current exclusions

After the user's latest instruction, all new editor changes were removed. Current editor source is compared with the starting branch head, while the original processing and AD Master protection list is compared with original main. Earlier committed work has not been rewritten.
