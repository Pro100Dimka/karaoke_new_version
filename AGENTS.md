# Room work completion gate

These rules are mandatory for every change that affects rooms, room audio, karaoke synchronization, multi-instance startup, project transfer, or audio-device switching.

- Never describe room work as complete, ready, fixed, working, ideal, or verified from unit, integration, simulated-network, backend-only, or AudioService-only tests.
- Before any completion statement, build and launch the application through `start-multy.bat` using the normal developer profile and the isolated guest profile.
- Exercise the affected scenario through the rendered UI in both real Electron windows. Calling room APIs or AudioService commands directly is diagnostic evidence only and does not satisfy this gate.
- For room singing/audio work, verify actual microphone capture and remote playback in both directions. Record diagnostics from both AudioService processes, including backend, sample rate, period/buffer, packets sent/received, RTT, jitter, target delay, queue fill, underruns, overruns, and alignment error.
- For synchronized karaoke work, verify both visible timers and authoritative AudioService playback positions throughout start, pause, resume, seek, stop, late join, reconnect, and return to the library. The permitted steady-state difference is 2 ms unless the product requirement is stricter.
- Verify the project-download loader remains visible until every participant is ready; controls must not become usable before readiness.
- Verify the saved recording contains the audible master/performance mix, not microphone-only audio.
- Verify Shared, Exclusive, and ASIO switching while the room is connected when those modes are involved in the change.
- Close both UI instances after the scenario and confirm that no Electron, Python backend, or AudioService process belonging to those instances remains.
- Save a timestamped evidence report under `artifacts/room-e2e/` with screenshots and machine-readable diagnostics. A completion statement must link that report.
- If any required live check fails or cannot be executed, state that the work is not complete and name the failing check. Do not substitute a promise, inference, or narrower test.

Automated regression tests remain required, but they are only a prerequisite for the live gate above.
