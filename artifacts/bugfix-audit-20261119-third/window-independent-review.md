# Independent focused review: window controls on error screens

Reviewer: `/root/visible_rooms_social_audit`, 2026-11-19.

## Verdict

**No actionable regression found in the reviewed diff.** The changes restore the existing window-control component on two screens that replace `AppShell` in a frameless Electron window. No product or test file was edited during this review.

## Scope and checks

Reviewed the complete working-tree changes and tests in:

- `frontend/src/app/BootstrapGate.tsx`
- `frontend/src/app/BootstrapGate.test.tsx`
- `frontend/src/providers/error-boundary.tsx`
- `frontend/src/providers/error-boundary.test.tsx`

Also traced the relevant existing owners: `TitleBar`, `useWindowState`, `pages/index`, `AppShell`, close-request subscriptions, native window close/confirmation handling, global title-bar CSS, and the installed Neo UI `Dialog` implementation.

### Ownership and close behavior

- `MainWindow` uses `frame: false`; these fallback screens previously omitted the controls supplied by `AppShell`.
- `BootstrapGate` renders its title bar only while displaying its unavailable/incompatible screen. Once admitted, it returns the children, which own the ordinary shell title bar. The new handoff test asserts a single toolbar after recovery.
- `ErrorFallback` replaces the error-boundary children, so the previous `AppShell` title bar unmounts before the fallback owns its replacement. There is no new simultaneous title-bar owner in this path.
- The native Close action still has a subscriber: `subscribeCloseRequests` is registered in the parent `App` above both `ErrorBoundary` and `BootstrapGate`. It remains mounted during these fallbacks and calls `desktopClient.confirmClose`. The absence of `AppCloseFlow` inside a fallback does not strand the new Close button waiting for a missing `closeRequested` subscription.
- The changes do not register extra close guards or change the close protocol.

### Subscriptions and modal controls

- `useWindowState` unregisters its subscription and ignores late initial queries on unmount. `TitleBar` disconnects its `MutationObserver` and aborts native pointer/double-click handlers on unmount, so fallback-to-shell replacement does not leave duplicate listeners.
- In a native modal, the existing title-bar implementation portals its controls into the topmost dialog and opens a manual popover. The controls thereby remain descendants of the modal and can escape its clipping. Global `app.css` supplies the existing positioning; it is statically imported through `AppShell` even when the shell is not rendered.
- The installed Neo UI `Dialog` opens with `showModal()` when supported; its `open` mutation is observed by the existing title bar. The diff does not modify this mechanism or introduce a second modal.

## Verification evidence and limits

Scoped `git diff --check` exited 0. Inspected the root's `third-window-green.log`: **3 files / 5 tests passed**. No full suite was run by this reviewer, and the already available focused test run was not redundantly repeated.

The new tests use the real Neo UI components and verify controls and desktop calls. However, `frontend/src/test/setup.ts` does not implement native `showModal`; jsdom therefore uses the kit's `open`-attribute fallback, and `TitleBar.useTopModal` exits early. These tests **do not verify native dialog inertness, popover placement, pointer hit-testing, or actual Electron IPC execution**. Those paths were traced in source, not live-verified by this review. The runtime error test renders `ErrorFallback` directly rather than throwing inside the full application boundary.

## Reviewed source hashes

| File | SHA-256 |
| --- | --- |
| `frontend/src/app/BootstrapGate.tsx` | `778e49ac23d617313adfd13d0a5f78e6c99639fd59d7873a6de89ff870e355fe` |
| `frontend/src/app/BootstrapGate.test.tsx` | `ca7b8728293b1b38e979638715c2f9980f7f9cdc8062d55199e2e55edbfd8d80` |
| `frontend/src/providers/error-boundary.tsx` | `ed81fd630cd795a34c3088e3971ce2cf6429118c16cf28d7bda2fb97a6845635` |
| `frontend/src/providers/error-boundary.test.tsx` | `1a539e35d5ce0c0f296022ee71a27f4af9b7ebcc085469e84be3cbf78b4d5577` |

No editor files or other excluded product paths were changed.
