# Final rules compliance audit

Date: 2026-09-18

This audit separates source/code compliance and deterministic portable evidence from Windows hardware
certification. Hardware-dependent requirements are never marked passed without the required hardware.

## Corrected in this pass

- `GenerationId`, `SourceGenerationId`, `SessionFrame` and `SequenceNumber` are distinct strong types.
- Generation protection now covers backend, media, recording, analysis and network asynchronous work.
- Remote receive queue overflow is explicit and counted; stale network work is counted and rejected.
- Tests are individual behavioral cases instead of large `mediaTests()` / `sessionTests()` aggregations.
- Hard-RT instrumentation covers allocation, free, blocking mutex use, disk I/O, network I/O and IPC.
- Device-loss failure state is captured before recovery in a bounded diagnostic snapshot.
- Media decoder failures preserve a bounded actionable reason instead of only setting `Failed`.
- Large command handling was split without creating a second service or new ownership layer.
- WASAPI PCM boundary conversion is isolated beside the WASAPI backend; no duplicate implementation exists.
- `.clang-format`, `.clang-tidy`, a project formatter and Clang Static Analyzer gate are present.
- FakeBackend supports deterministic packet patterns, drift, timestamp jitter, scheduled faults, stale callbacks
  and timing/event replay without storing PCM.
- Trace storage is bounded to the last 32 events and reports overwritten/dropped events.
- Seeded state fuzzing is part of normal CTest and uses a fixed reproducible seed.
- A separate release repetition target executes 10,000 Start/Stop, 1,000 reconfiguration and 1,000 recording
  Start/Stop cycles.
- Warnings-as-errors are applied to all project-owned CMake targets.
- Windows build and MSVC `/analyze` scripts are included.

## Verified in this environment

- GCC C++20 Release build with warnings as errors.
- Clang C++20 Release build with warnings as errors.
- Portable CTest suite.
- Clang Static Analyzer over portable production sources.
- AddressSanitizer + UndefinedBehaviorSanitizer test run.
- Hard-RT FakeBackend callback test reports zero allocation/free/blocking/disk/network/IPC violations.
- Seeded state-machine fuzz test passes.
- 10,000 Start/Stop repetition gate passes.
- 1,000 reconfiguration repetition gate passes.
- 1,000 recording Start/Stop repetition gate passes.
- No `TODO` / `FIXME` / `HACK` markers in production or tests.
- No `sleep_for`, `Sleep`, `wait_for` or `wait_until` synchronization in production/tests.
- No hidden `std::queue`, `std::deque`, `std::map` or `std::unordered_map` audio queues.
- No Legacy/Old/New/V2/V3/Final parallel implementation files.
- No source/test file exceeds 500 lines and no function exceeds 100 lines in the final source audit.
- C++ source is reproducibly formatted using the repository `.clang-format`.

## Explicit boundary: still requires external verification

The following requirements cannot be honestly certified by this Linux/no-audio-hardware environment:

- Windows SDK/MSVC compilation of the Windows-only translation units;
- WASAPI Shared/Exclusive behavior on real endpoints and minimum-stable-period tuning;
- vendor ASIO drivers, reset/late-callback/hostile-driver behavior;
- physical loopback / real round-trip latency;
- device unplug/disable/default-change, Windows Audio service restart and sleep/resume on hardware;
- real CPU/DPC scheduling pressure and xrun/deadline measurements on the target Windows matrix;
- onboard/cheap USB/headset/separate USB mic+output/USB interface/ASIO hardware certification;
- actual internet loss/jitter/stall and long multi-user remote synchronization;
- 1-hour, 8-hour and 24-hour wall-clock soak gates;
- final user acceptance after hardware measurements.

A real external driver call that never returns also still needs target-platform watchdog/process-lifecycle
certification. FakeBackend can reproduce scheduled failure/late callback/timing traces, but it does not pretend a
real hung kernel/vendor driver was safely terminated.

## Conclusion

The source tree now satisfies the audited code/architecture rules and all deterministic portable gates that can
be executed here. It is **not** labelled fully release-certified until the external Windows/hardware/soak/user
verification list above is completed on the target systems.
