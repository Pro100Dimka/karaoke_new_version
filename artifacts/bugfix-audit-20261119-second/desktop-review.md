# Second desktop audit — frozen changes and evidence

Date: 2026-11-19
Repository: `/workspace/scratch/726a7fe1e251/karaoke_new_version`
Branch: `fix/app-bugs-excluding-processing-20261119`
Starting HEAD: `34eae170d0a12beea5ae48421fe334b93dda7969`
Agent: `/root/second_desktop_audit`

## Scope and status

Three new functional fixes were implemented in six Electron files. Every defect had a regression test written first and an actual failing execution before its product change. Product and test sources are frozen. The root agent coordinates commits, publishing, full suites, and the final combined audit report.

This agent made no commits, push, PR, full-suite runs, processing changes, ADMaster changes, or DSP changes. The protected processing/ASR/separation/alignment/pitch/DSP and ADMaster implementations, tests, configuration, and startup/configuration semantics were not modified.

The root subsequently reported that full native and frontend checks ran on the frozen sources. Their results belong in the combined root report; the evidence below records only this agent's directly observed checks.

## Confirmed defects and corrections

### 1. Desktop commands disappeared during renderer replacement

`ShellIpc.ts` disconnected `DesktopShell` only after an explicit renderer cleanup IPC call. Reload, crash, and destruction cannot reliably execute renderer cleanup. The shell continued sending commands into the old renderer instead of queueing them until the replacement subscribed.

The fix binds readiness to the current renderer and disconnects on renderer crash, WebContents destruction, and main-frame navigation to a new document. Same-document navigation and subframe navigation remain connected. Repeated readiness detaches previous lifecycle hooks. Late events from an old owner cannot disconnect a newly ready renderer.

Regression evidence:

- `/workspace/scratch/726a7fe1e251/second-desktop-shell-red.log`: 3 failed, 1 passed before the product fix.
- New `frontend/electron/ShellIpc.test.ts` covers crash/destroy/reload queueing, exactly-once delivery after readiness, same-document/subframe navigation, old-owner events, and repeated subscription cleanup.
- The final focused run passed all related tests.

### 2. Audio notification streams survived renderer crashes

`ServiceIpc.ts` released notification subscriptions on full navigation and WebContents destruction but not on `render-process-gone`. A repeatedly crashing renderer is deliberately not auto-reloaded by the main-window crash loop guard. In that scenario its notification sockets and reconnect activity remained running without a live consumer.

Added the missing crash cleanup hook. Transport framing, intervals, native audio control, and audio processing are unchanged.

Regression evidence:

- `/workspace/scratch/726a7fe1e251/second-desktop-notifications-red.log`: 1 failed, 1 passed before the product fix.
- The added regression checks that both active streams are released, a replacement renderer can subscribe, and later destruction releases only the replacement subscription.
- The final focused run passed both ServiceIpc and AudioServiceTransport coverage.

### 3. A replacement main window inherited the previous window's state

The macOS activation path keeps the process alive and creates another main window after the old one closes. `mainRevealed` and `closeConfirmed` were process-global and never reset.

Two consequences were reproduced:

- The replacement window begins with `show: false`, but its readiness notification cannot reveal it because the previous window already set `mainRevealed`.
- The previous window's close approval remains effective and bypasses the replacement window's unsaved-work confirmation.

`openMainWindow()` now resets both values before creating the replacement.

Regression evidence:

- `/workspace/scratch/726a7fe1e251/second-desktop-reactivation-red.log`: 2 failed, 26 passed before the product fix.
- The main-process integration fixture exercises replacement-window reveal and renewed close confirmation.
- The final focused run passed both scenarios and the neighboring main-process tests.

## Changed files

Product files:

- `frontend/electron/ShellIpc.ts`
- `frontend/electron/ServiceIpc.ts`
- `frontend/electron/main.ts`

Test files:

- `frontend/electron/ShellIpc.test.ts` — new file; it was untracked at the agent's freeze handoff and must be included when staging.
- `frontend/electron/ServiceIpc.test.ts`
- `frontend/electron/main-security.test.ts`

## Verification after the final edit

| Check | Observed result | Evidence |
| --- | --- | --- |
| Focused Electron tests: ShellIpc, DesktopShell, ServiceIpc, AudioServiceTransport, main-security, MainWindow.startup | 72 tests, 6 suites passed; exit 0 | `/workspace/scratch/726a7fe1e251/second-desktop-final-focused.log` |
| Electron TypeScript | Passed; exit 0 | `/workspace/scratch/726a7fe1e251/second-desktop-typecheck.log` |
| Architecture | Passed; exit 0 | `/workspace/scratch/726a7fe1e251/second-desktop-architecture.log` |
| Whitespace check on owned files | Passed | `git diff --check` |

Focused command, executed from `frontend`:

```sh
node node_modules/vitest/vitest.mjs run electron/main-security.test.ts electron/MainWindow.startup.test.ts electron/ShellIpc.test.ts electron/DesktopShell.test.ts electron/ServiceIpc.test.ts electron/AudioServiceTransport.test.ts --maxWorkers=2
```

Type and architecture commands, executed from `frontend`:

```sh
node node_modules/typescript/bin/tsc -p electron/tsconfig.json --noEmit --pretty false
node scripts/check-architecture.mjs
```

The individual RED logs preserve the failing assertions before implementation. Intermediate green evidence also exists in `second-desktop-shell-green.log` and `second-desktop-notifications-green.log`; the final focused log supersedes those intermediate runs for the final source state.

## Reviewed behavior and modules

This section records source review coverage. It does not imply live execution of every listed behavior.

### Managed service lifecycle

Reviewed `ServiceProcess`, `ManagedServices`, `BackendEndpoint`, and main startup/quit handling. Examined partial startup, graceful versus forced shutdown, pending restart cancellation, endpoint invalidation, old process output, and duplicate-start reachability. Protected processing/model/runtime configuration semantics were treated as boundaries and left unchanged.

### IPC and renderer lifetime

Reviewed `TrustedIpc`, `ServiceIpc`, `AudioServiceTransport`, `ShellIpc`, `DesktopShell`, `DesktopIpc`, `MainWindow`, and preload subscriptions. Examined notification ownership, serial request deadlines, crash/reload behavior, readiness, and navigation semantics.

### Window and panel behavior

Reviewed `PanelWindows`, `WindowState`, `AppVisibility`, `TrayRadio`, and desktop launch integration. Examined visibility, child ownership, persisted placement, tray recovery, and main-window reactivation.

### Files and downloads

Reviewed `ProjectFiles`, `PathPolicy`, `PeaksService`, `WavFile`, `WavPeaksWorker`, `SceneProtocol`, `RoomProjectTransfer`, `AutoUpdate`, and `Asio4AllInstaller`. Examined scope validation, worker/cache ownership, response cleanup, cancellation, temporary files, resumable update downloads, checksums, and quit/installer ordering.

### Desktop integrations and communications

Reviewed `SocialSocket`, `SocialChannel`, `SocialIdentity`, `RoomIdentity`, `RoomServerTransport`, `RadioNowPlaying`, `DiscordPresence`, `AppLogUploader`, `TaskbarIntegration`, `NotificationIdentity`, and request validation. No room transport or audio algorithm was modified.

### Startup and supporting paths

Reviewed `AppPaths`, `RuntimeIdentity`, `Splash`, GPU display switches, and the `start-electron.mjs` / `dev-electron.mjs` entry wrappers. Processing/model/runtime configuration semantics were not changed.

## Hypotheses deliberately not promoted into speculative fixes

- `ManagedServices.start()` itself is not idempotent, but the production main entry point guards repeated starts with `backendDataRoot`.
- `SocialSocket` could hypothetically overlap pending identity resolution across stop/start cycles. Production starts the instance once and stops it only during application shutdown; a consequential production sequence was not established.
- `BackendEndpoint.request()` overrides a caller signal, but no current caller supplies one. An unused cancellation contract was not changed without a reachable product failure.
- Broader cross-window transfer cancellation ownership was not changed because `TrustedIpc` admits only the current main renderer.
- Updater concurrency has a shared `checking` guard and serial launch/background scheduling; no new reproduced download collision was found there.
- Desktop-launch and Discord shutdown hook cleanup has theoretical late-event cases, but no consequential event sequence before process exit was established.

This was a systematic additional pass. It is not proof that the entire application has no remaining defects.

## Independent review of the root's native patch

Reviewed the root's change to `AudioService/src/media/MediaSource.cpp`, `requestSeekLocked`, worker request consumption, generation checks, `publishPendingPcm`, and the newly registered `stoppingLoadingMediaWaitsForDecodedAudio` test.

No regression was found in the one-line Loading guard:

- `stop()` still executes `requestSeekLocked(0)` under the mutex and `RenderPause`.
- Rewind, clock reset, ring reset, decoder cancellation, and generation advancement are preserved.
- Only premature publication of `Ready` is suppressed while the source remains `Loading`.
- The worker consumes the latest seek, rejects stale decoded generations, and publishes `Ready` after current-generation audio or EOF.
- Repeated Stop retains the same rewind intent.
- The new test covers a blocked decoder, repeated Stop, rejected premature Play, eventual readiness, and subsequent rendering.
- The patch does not alter DSP behavior.

At review time the test checked rendered frame count rather than asserting the first rewind sample or position. The source preserves rewind explicitly, and neighboring seek/generation tests cover that machinery. No product blocker was found from that limited assertion gap. Any later root changes to the test should be described in the combined report.

## Limits and outstanding live gates

Real Windows room/device verification and real macOS activation were unavailable. The corrected lifecycle outcomes have automated regression evidence; they do not constitute live desktop verification.

The repository's mandatory `start-multy.bat` two-window gate was not executed by this agent. Room, device, and synchronization work must not be described as fully verified from these tests. The root's combined report must state the applicable unexecuted live checks and its complete frozen-source suite results.

**Source and test freeze:** all six owned files were frozen before the root-coordinated full suite runs. This documentation-only handoff made no additional source or test changes and ran no further tests.
