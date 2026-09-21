# AudioService progress

This file is the authoritative status record for this source tree. Requirement documents under
`docs/specification/` describe the target; they do not by themselves mark work as complete.

## Status vocabulary

- **Verified portable** — implemented and exercised by the deterministic portable test build.
- **Source present / Windows verification required** — implementation exists, but this Linux build
  cannot prove Windows SDK compilation or real driver/device behaviour.
- **Release gate pending** — the specification requires measurement, stress/soak, hardware or user
  verification that has not been performed in this environment.

## Core / main phase

| Area | Status | Evidence in this tree |
| --- | --- | --- |
| Standalone process, service lifecycle, IPC protocol versioning | Verified portable | `AudioService`, `AudioControl`, protocol tests |
| Session state machine and `generationId` stale-callback protection | Verified portable | session tests and fake-backend recovery tests |
| Requested / capabilities / runtime / final plan separation | Verified portable | session/backend contracts |
| Bounded realtime PCM buffers and preallocated scratch memory | Verified portable | realtime tests, allocation guard |
| Bare capture -> clock bridge -> mixer -> render path | Verified portable with Fake backend | realtime/session tests |
| Clock observation, drift estimate and bounded correction | Verified portable | clock tests |
| Diagnostics, trace, graph introspection and latency registry primitives | Verified portable | diagnostics tests |
| Recording queue/worker/WAV writer/gap metadata | Verified portable | recording tests |
| Analysis worker and lightweight signal metrics | Verified portable | signal/analysis tests |
| UDP send/receive, PCM codec, bounded adaptive jitter and participant sources | Verified portable/local | network tests |
| DSP chain and explicit DSP latency | Verified portable | DSP tests |
| WASAPI Shared / Exclusive implementation | Source present / Windows verification required | `src/backend/wasapi/` |
| ASIO implementation | Source present / Windows verification required | `src/backend/asio/` |
| Windows device discovery / notifications | Source present / Windows verification required | `src/devices/WindowsDeviceManager.cpp` |
| Windows named pipe / Media Foundation decoder | Source present / Windows verification required | Windows-only source files |
| Backend-call hang timeout enforcement | Release gate pending | external driver calls still require target-platform timeout validation |
| Fake clock/jitter/fault/replay coverage | Verified portable except true driver-hang termination | packet patterns, drift, timestamp jitter, scheduled faults, stale callbacks and timing/event replay are deterministic |
| Timing/event trace replay | Verified portable | FakeBackend replays positions/timestamps/events without storing PCM; bounded trace keeps the last 32 events |
| State fuzz and repetition gates | Verified portable | fixed-seed fuzz plus 10,000 Start/Stop, 1,000 reconfigure and 1,000 recording cycles pass; target-hardware stress remains external |

## Runtime media / Phase II

| Stage | Status | Notes |
| --- | --- | --- |
| II.0 media ownership / transport context | Verified portable | one `MediaController`, one mixer/render path; no second player graph |
| II.1 prepared song + basic transport | Verified portable for WAV/fake path; Windows decoder requires Windows verification | load/play/pause/seek/stop, bounded source buffer, stale-source generation tests |
| II.2 rate / transpose / reference vocal | Verified portable functionally | quality/CPU certification across supported ranges remains a release gate |
| II.3 recording lifecycle | Verified portable | prepare/start/pause/resume/stop/finalize, duration/gaps |
| II.4 live metrics / device tests | Portable logic verified; physical device tests pending | peak/RMS/presence/clipping and output tone exist |
| II.5 editor + recording preview | Verified portable | transport, seek and loop use shared media path |
| II.6 radio | Source path present; real network/Windows decode verification pending | bounded media source and context exclusion rules exist |
| II.7 remote media lifecycle | Verified portable/local at component level | real network fault/long-sync certification pending |
| II.8 settings / diagnostics / failure isolation | Partial | core settings/failure isolation exist; full per-path measured latency breakdown is not release-certified |
| II.9 combined Baseline C | Release gate pending | requires real target hardware, measurements and user verification |

## Audited portable checks

The audited tree has been rebuilt from source with:

- GCC C++20 Release, warnings as errors;
- Clang C++20 Release, warnings as errors;
- CTest portable suite;
- AddressSanitizer + UndefinedBehaviorSanitizer;
- hard-RT instrumentation guard for allocation/free/blocking/disk/network/IPC in the FakeBackend callback path;
- Clang Static Analyzer;
- fixed-seed state fuzz;
- 10,000/1,000/1,000 release repetition gates.

The audit also added/fixed regression coverage for stale media PCM across source-generation changes,
bounded jitter storage, recording gap metadata, and realtime buffer invalidation.

## Release gates still required

This project must **not** be called release-complete until the specification's external gates are
actually performed. At minimum this includes:

1. Windows x64 build with the supported Visual Studio/Windows SDK toolchain.
2. Real WASAPI Shared and Exclusive device tests across the hardware matrix.
3. Real ASIO vendor-driver tests, including reset/stop/close hostile-callback cases.
4. Physical loopback latency measurements and minimum-stable-period tuning.
5. Baseline A/B/C CPU, peak deadline margin, xruns, memory and latency measurements.
6. Unplug/disable/audio-service-restart/sleep-resume/reconfiguration checks on hardware.
7. Network loss/jitter/reordering/stall and long remote synchronization tests.
8. 1 h development, 8 h pre-release and 24 h release-candidate soak gates.
9. Final user verification required by the staged workflow.

Until those gates are completed, the accurate status is **implementation candidate with portable
verification**, not a fully certified release.
