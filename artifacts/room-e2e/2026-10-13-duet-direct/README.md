# 2026-10-13 — automatic direct duet, checkpoint

Status: NOT a technically accepted live duet. Continue here; do not restart capture/recovery investigation.

Implemented automatic two-person direct voice inside the ordinary room: authenticated fresh UDP address discovery, LAN candidate when appropriate, bilateral reception before switching, relay fallback, participant gain and session cleanup. Oracle remains the conductor/control service and fallback mixer. This is not full ICE/TURN and has not been tested through the friend's Internet NAT.

Production: user approved and installed six-file discovery package (`deployment-result.json`), then five-file direct timing package (`timing-candidate/deployment-result.json`). Both health checks passed. Native relay unchanged by the second package. Rollbacks remain in their respective /tmp/advoice-duet-direct[-timing]-20261013/rollback directories.

Fixed an additional confirmed integration error: direct paths have no relay return/arrival measurements, which the server previously treated as endless calibration and selected 110 ms. Client now explicitly reports the route. For two calibrated direct participants the server chooses the larger whole-path requirement. Actual ordinary-room restart selected **40 ms / Measured**, not ReturnCalibrating. A route change is published even if the measured latency is unchanged. This corrects scheduling; it does not fix late delivery.

Physical machines: main ASIO Audient 44,100 Hz / 128; laptop WASAPI Exclusive 48,000 / 240; ordinary start.bat, both 5 GHz Wi-Fi. Ethernet unavailable. Both microphones logically enabled, monitoring OFF, original vocal zero. Distinct diagnostic tones 697/941 Hz replace microphone input before DSP/send to prevent acoustic feedback. They exercise transport/resampling/output, not physical microphone quality or human causal duet behavior.

Evidence:

- `clean-direct-diagnostics.json`, `clean-direct-main.wav`: earlier 110 ms run, main Audient hardware Loop-back signal continuous in analyzed 20–64 s segment (941 Hz band RMS min .01137, median .01189); laptop gained 2 late nonzero cuts during 28.8 s. Not a whole-song pass.
- `measured-direct-*`: INVALID as clean comparison. Excessive full-trace CDP polling added Wi-Fi traffic; do not use its improvement/regression as a causal diagnosis. First laptop relaunch also reused its closing old process; corrected by waiting for process exit and rebuilding.
- `measured-clean-diagnostics.json`, `measured-clean-room.json`: corrected builds, low-volume diagnostic polling, automatic direct both ways. Fixed 40 ms. From sample 2 to last (30.401 s), main nonzero late cuts 0→211; laptop 12→398. Main confirmed device underruns remained 0; laptop remained 19. Sender maximum gap main 4.383 ms; laptop 14.256→15.436 ms. Receive gap maxima main 96.254 ms and laptop 62.251→66.015 ms (lifetime maxima, not all newly occurring).
- `measured-clean-main-trace.txt`, `measured-clean-laptop-trace.txt`: frozen packet traces show actual nonzero packets already late at socket receipt. Example main microphone-timestamp→socket 51.833 ms; laptop 47.479 ms; their deadlines 40 ms. Socket→processing only 0–2 microseconds in those examples. These intervals include capture/timestamp/network/clock effects, not pure Wi-Fi latency.
- `measured-clean-main.wav`: actual Audient hardware Loop-back, not just the application master recording. 941 Hz band contains sustained drops (e.g. 72.74–73.00 s, 80.94–81.27 s in capture). Short run FAILED continuity.

Laptop physical Exclusive output has NOT been independently captured: parallel DirectShow capture of the built-in microphone failed, Stereo Mix is disabled. Do not claim backend output buffers or aligned performance recordings prove its actual output. No full song/restart acceptance, monitor-OFF user-recording acceptance, friend Internet test, or human duet pass is claimed.

Tests: native Windows 402; frontend full 890 (first attempt one timing-sensitive security test failed under concurrent CPU load, isolated and full repeat passed); first server package Python Windows/Linux ARM64 105 each, native relay Linux 32. Additional timing fix: Windows Python 90, Linux ARM64 policy/server 56, frontend targeted 85, TypeScript pass. Linux desktop fixture tests require the full desktop application and were tested on Windows instead. RED tests reproduced missing direct endpoint lifecycle/timing behavior before changes.

Remaining blocker: late delivery still exceeds the singing budget even on the direct path. Reducing deadline causes real audio loss. Increasing it would add audible response latency and does not prove a live duet. No evidence yet identifies Wi-Fi alone as the cause; no wired comparison is available. Avoid more smaller-deadline sweeps. Next useful check must discriminate sender/OS/network waiting without loading the same wireless link with full diagnostics. Physical laptop output and actual friend Internet path remain acceptance gaps.
