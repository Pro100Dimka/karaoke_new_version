# Working launch and verification

- Use `start.bat dev` for non-room renderer work: Vite hot-reloads React/CSS without rebuilding `dist`. Electron, Python and AudioService changes need a restart. An already running application must be closed normally before changing launch modes; do not kill a user's recording or processing job. Use `start.bat` to verify the bundled renderer when the change requires it.
- Run checks from the repository root with `check.bat`. It preserves the existing test commands and returns a nonzero exit code on failure. Checks do not run npm/pip installation; use the existing installer if required tools are missing.

| Area | Intermediate regression check | Full affected verification |
| --- | --- | --- |
| Renderer | `check.bat frontend src/app/serviceStatus.startup.test.ts` (replace with the affected test) | `check.bat frontend` (types, architecture, Vitest, Electron/Node tests) |
| Electron / scripts | `check.bat frontend scripts/startup-lock.test.mjs` (or the affected `electron/...` test) | `check.bat frontend` |
| Python backend | `check.bat backend tests/test_installer_contract.py` (or the affected test, optional `::test_name`) | `check.bat backend` (compile, architecture, bootstrap, required Ruff/mypy, full pytest) |
| AudioService | `check.bat audio wavDecoderReportsFormat` (or the affected native test names) | `check.bat audio` (incremental build of all configured targets, full registered CTest suite) |
| Cross-layer change | Run the regression tests for each changed area | `check.bat all` (the three full suites, sequentially to avoid competing with audio tests) |

- Add the reproducing test first and confirm it fails before implementation. Focused checks are intermediate feedback, not completion evidence. Run the full affected suite after the final edit; rerun it if relevant source, tests, configuration or dependencies change. Do not omit tests, lower thresholds, ignore failures, or use an old successful run to validate changed code.
- No-argument `check.bat` runs all full suites. These commands do not replace scenario-specific browser, real-device, room, synchronization or release gates below. Keep every gate applicable to the change.
- `check.bat` puts per-process temporary files and supported caches under `E:\CodexTemp\ADVoice-checks` when E: exists. For assistant-launched application runs, set TEMP/TMP and any isolated test data under the task's directory on E:; share existing model files instead of copying them. Do not relocate the normal user's profile.
- Save full check output under the task's E: directory and inspect the summary or failure details. Preserve the command's exit code before reading the log. Keep output focused instead of returning entire successful logs to the model.

# Room work completion gate

## Non-negotiable room-audio architecture

For the synchronized-room work, `Room Server` is the only conductor and the central audio
mixer. This is an architectural requirement, not an implementation suggestion.

- The server owns the authoritative musical timeline and the playout deadline.
- Participants send microphone audio upstream with musical-timeline timestamps.
- Every client renders its local project copy on the server's scheduled musical position and
  monitors its own processed microphone locally, without a network round trip. The server receives
  every timestamped microphone, aligns the eligible remote voices, and returns a per-recipient
  mix-minus containing all other eligible singers. This practical split is required so delayed
  self-monitoring cannot disrupt the performer.
- Do not replace the server mix-minus with participant-to-participant voice mixing, a human host as
  the audio leader, independent backing-track delays, or clock synchronization without server-side
  remote-voice mixing.
- The server-returned remote voices use one fixed low-latency deadline selected before singing; the
  deadline is never increased during a song because of a slow participant.
- A microphone packet that misses the server deadline for its musical position is never rendered
  later. Exclude that stream from the live mix; rejoin it only at the current musical position
  after it has met the deadline continuously for the recovery window.
- Initially support and verify 3–4 participants on the existing Oracle Room Server.
- If a causal, UX, capacity, or implementation constraint conflicts with these requirements, stop
  and report the exact conflict. Never silently substitute a P2P, leader/follower, best-effort, or
  otherwise narrower design and call it the requested server-conductor architecture.

Use `start-multy.bat` for live verification that involves a room, room audio, room
synchronization, multi-instance behavior, or project transfer. For live verification of a
non-room feature, launch the ordinary single application through `start.bat`; do not require a
second profile when the behavior cannot involve a room.

These rules are mandatory for every change that affects rooms, room audio, karaoke synchronization, multi-instance startup, project transfer, or audio-device switching.

- Never describe room work as complete, ready, fixed, working, ideal, or verified from unit, integration, simulated-network, backend-only, or AudioService-only tests.
- Before any completion statement, build and launch the application through `start-multy.bat` using the normal developer profile and the isolated guest profile.
- Exercise the affected scenario through the rendered UI in both real Electron windows. Calling room APIs or AudioService commands directly is diagnostic evidence only and does not satisfy this gate.
- For room singing/audio work, verify actual microphone capture and remote playback in both directions. Record diagnostics from both AudioService processes, including backend, sample rate, period/buffer, packets sent/received, RTT, jitter, target delay, queue fill, underruns, overruns, and alignment error.
- For synchronized karaoke work, verify audible voice timing between singers in both directions throughout start, pause, resume, seek, stop, late join, reconnect, and return to the library. Record the relative timing of the voices; the target is no more than 30 ms of skew between singers.
- Verify the project-download loader remains visible until every participant is ready; controls must not become usable before readiness.
- Verify the saved recording contains the audible master/performance mix, not microphone-only audio.
- Verify Shared, Exclusive, and ASIO switching while the room is connected when those modes are involved in the change.
- Close both UI instances after the scenario and confirm that no Electron, Python backend, or AudioService process belonging to those instances remains.
- Save a timestamped evidence report under `artifacts/room-e2e/` with screenshots and machine-readable diagnostics. A completion statement must link that report.
- If any required live check fails or cannot be executed, state that the work is not complete and name the failing check. Do not substitute a promise, inference, or narrower test.

Automated regression tests remain required, but they are only a prerequisite for the live gate above.

## Research preference

When technical facts are unknown or uncertain, verify them on the internet before
relying on them. Prefer official documentation and primary sources; distinguish
documented behavior from hypotheses and locally measured results.
