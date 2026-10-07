# A&D Voice AudioService

C++20 standalone realtime audio/media service for the karaoke application.

## What is in the project

- standalone `AudioService` process and `AudioControl` client;
- versioned control IPC (Windows named pipe; Unix-domain socket for portable tests);
- strict service/session lifecycle with `generationId` stale-callback protection;
- capability-driven `RequestedConfiguration -> RuntimeConfiguration -> FinalSessionPlan`;
- Fake backend for deterministic variable packets, drift, jitter, faults, stale callbacks and timing/event replay;
- Windows WASAPI Shared and Exclusive backends (event-driven, MMCSS, runtime reread, padding diagnostics);
- Windows ASIO backend boundary with driver discovery, duplex buffers, callbacks/reset events;
- device discovery and Windows endpoint notifications;
- preallocated realtime buffers, bounded PCM rings and clock bridge;
- capture/render clock drift estimation and adaptive correction;
- one realtime graph and Mixer for microphone, music, reference vocal, editor preview, recording preview, radio and remote voices;
- DSP chain with explicit latency reporting;
- asynchronous media decoding with source-generation stale-PCM protection, seek, rate, transpose and preview loop;
- recording queue/worker/WAV writer with duration and gap metadata;
- live signal metrics and reference/output test tone;
- UDP network send/receive, Opus codec, adaptive jitter buffer and per-participant gain/mute/level;
- diagnostics, bounded failure snapshots, graph introspection, latency registry and last-32-event trace buffer;
- behavioral tests for realtime safety, bounded buffers, clocks, media, recording, network, DSP, IPC, recovery and diagnostics;
- fixed-seed state fuzz, Clang Static Analyzer, formatter config and optional release repetition gates.

The original requirement documents are retained under `docs/specification/`.

Current implementation status is authoritative in `docs/AudioService-progress.md`; the second-pass rule audit is in `docs/COMPLIANCE-AUDIT.md`.

## Windows build

Requirements: Windows 11, Visual Studio 2022 Build Tools with Desktop development with C++, CMake 3.24+.

```bat
build-windows.bat
```

The script configures an x64 Release build, compiles all project targets with warnings as errors and runs CTest. `build-windows-analysis.bat` additionally enables MSVC `/analyze`.

Run the service:

```bat
build-windows\Release\AudioService.exe
```

Examples:

```bat
build-windows\Release\AudioControl.exe state
build-windows\Release\AudioControl.exe devices
build-windows\Release\AudioControl.exe audio-dump
build-windows\Release\AudioControl.exe PrepareSession backend=wasapi-shared rate=48000 period=128
build-windows\Release\AudioControl.exe StartSession
build-windows\Release\AudioControl.exe SetMonitoring enabled=true
```

ASIO drivers are discovered from the standard Windows `SOFTWARE\\ASIO` registry location. The service does not hard-code device names, sample rates, buffer sizes or channel counts.

## Deterministic room-network verification

`AudioService.exe --network-test` sends one WAV through two independent Opus encode, impaired-network, jitter-buffer and decode paths. It writes a three-channel WAV (`A`, `B`, `mix`) and prints JSON containing sample offset, milliseconds, correlation and per-path timing/packet metrics.

```bat
build\Release\AudioService.exe --network-test ^
  --input reference-vocal.wav --output network-test-output.wav ^
  --latency-a 20 --jitter-a 3 ^
  --latency-b 65 --jitter-b 12 --loss-b 0.01 ^
  --duplicate-b 0.001 --reorder-b 0.005 --seed 12345
```

From `frontend`, `npm run test:audio-network-vocal-processes` starts two real `AudioService.exe` processes through a fixed-seed UDP impairment proxy. It uses an existing processed `reference-vocal.wav` as microphone PCM and writes its evidence and JSON report under `AudioService/build/network-process-test/`.

`npm run test:audio-network-resilience` starts four real processes and covers late join,
leave/rejoin, process restart, full outages, burst loss, asymmetric routes, drift, jitter,
bandwidth queues, duplicated/reordered/corrupted/unauthenticated packets and a 500 ms process
stall. Its three-channel evidence (`backing`, `aligned remote voice`, `performance mix`) and JSON
report are written under `AudioService/build/network-resilience-test/`; the gate compares the
post-recovery WAVs in samples instead of relying on a listening judgement. The gate requires
post-recovery alignment within 96 samples (2 ms at 48 kHz), expires silent routes from the adaptive
target and bounds the pathological shared playout target at 450 ms so an outage cannot permanently
ratchet the room to the full queue capacity.

`npm run test:audio-network-soak` is the 30-minute real-time two-process gate. For a shorter
diagnostic run use `node electron/network-soak-test.mjs --minutes=5`. It changes latency during
the run, injects a ten-second outage, ±100 ppm clock drift, jitter, burst/random loss,
duplication, reordering and a bounded-bandwidth queue. The result is
`AudioService/build/network-soak-test/network-soak-report.json`.

## Audio quality evidence

`node AudioService/tools/audio-quality-test.mjs --local --stress` runs the production
Windows AudioService under fixed-seed CPU affinity, contention, memory and scheduling
profiles. `--local` alone runs the normal, WASAPI Exclusive, recovery and concurrent
recording rows. Use `--scenario cpu-saturation --seed 12345 --seconds 5 --out <dir>`
to reproduce one row. `--plan` prints the matrix without using audio hardware.
`--room`, `--room --stress`, and `--all` keep separate room rows. The normal room
row runs the existing rendered two-window `start-multy.bat` Playwright gate and
links its screenshots, WAVs and diagnostics. The weak-participant rows remain
`INCONCLUSIVE` until their participant-specific load and PCM oracle are implemented.

Each local row saves a generated source WAV, performance recording, diagnostics,
load configuration, CPU/memory samples, and a bounded WASAPI Shared pre-submit PCM
capture. The first music-only second is compared against its source. Live microphone
quality remains `INCONCLUSIVE` without a known capture reference and acoustic
loopback. WASAPI Exclusive currently has no pre-submit capture hook. The CPU and
memory profiles are controlled stress conditions, not a substitute for a real weak
computer. The runner exits 0 for PASS, 1 for FAIL and 3 for INCONCLUSIVE.

`python AudioService/tools/pcm-continuity.py compare <reference.wav> <capture.wav> <out-dir>`
compares known post-DSP PCM after gain, delay and optional sample-rate alignment,
reports defect locations, and saves short excerpts. `calibrate <report.json>` records
false positives and missed defects on fixed synthetic corruptions. The WAV comparison
does not prove what emerged from a physical speaker.

## Portable verification build

The portable build uses `FakeAudioBackend` and the Unix control socket. It exists for deterministic CI/testing of the audio core; Windows production backends are only compiled on Windows.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DAUDIOSERVICE_WARNINGS_AS_ERRORS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Important verification boundary

The source contains the Windows production paths, but a Linux build cannot prove Windows SDK compilation, driver-specific ASIO behaviour, physical round-trip latency, device unplug/recovery on real hardware, or multi-hour hardware soak results. Those checks must be executed on the target Windows hardware matrix before a production release. This is intentionally not represented as already measured data.

## Formatting and static analysis

`python tools/format.py` formats all C++ sources using `clang-format` when installed, otherwise the formatter embedded in `clangd`. `tools/static-analysis.sh` performs a clean Clang warnings-as-errors build, runs Clang Static Analyzer and then CTest.

## Release repetition gates

Set `AUDIOSERVICE_BUILD_RELEASE_GATES=ON` to build the separate repetition runner. It covers 10,000 Start/Stop, 1,000 reconfiguration and 1,000 recording Start/Stop cycles and is intentionally separate from the fast default test run.
