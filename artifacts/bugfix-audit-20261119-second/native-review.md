# Second native audit — 2026-11-19

Base for this pass: `34eae170d0a12beea5ae48421fe334b93dda7969`.
Branch: `fix/app-bugs-excluding-processing-20261119`.

## Confirmed defect and correction

Calling `MediaSource::stop()` while its decoder was still loading published `PlaybackState::Ready` immediately. A subsequent `Play` was accepted despite an empty PCM queue. The defect was reproduced with a decoder whose first read is explicitly blocked, so the result does not depend on a timing race in the test.

The correction retains `requestSeekLocked(0)` and all existing rewind, clock reset, cancellation, ring reset, and generation behavior. It only avoids publishing `Ready` while the state remains `Loading`. The existing worker publishes readiness after current-generation decoded audio or EOF.

The regression was added and executed before the product edit. Actual RED: one test case failed three assertions (premature readiness, accepted premature playback, empty subsequent rendering). GREEN: the same case passed after the two-line conditional. Seven focused lifecycle/seek/reconfigure cases passed. The new test is registered in both the test header and the main test table.

Product file: `AudioService/src/media/MediaSource.cpp`, only `MediaSource::stop()`.
Tests: `AudioService/tests/media/MediaTests.cpp`, `AudioService/tests/TestHarness.hpp`, `AudioService/tests/main.cpp`.

## Full verification after final native edit

- All configured native targets built successfully in Release with warnings as errors.
- Full CTest ran, without filtering any tests: 2 of 3 CTest entries passed.
- The main test executable ran 512 cases: 509 passed and 3 failed.
- The new loading regression and all prior fixes passed.

Remaining failures are the already recorded baseline/platform failures:

1. `controlPipePreservesRepliesAfterServerClose` and `controlPipeStopCancelsIdleAndStalledClients`: this environment denies the required AF_UNIX stream socket. The earlier audit includes the direct EPERM probe and clean-main reproduction.
2. `performanceRecordingDrainsBeforeDeviceGenerationChanges`: unchanged recording test expects generation invalidation when suspension is refused by the existing active-recording guard. Earlier evidence reproduces it on clean main; recording behavior and the test remain unchanged.

The previously intermittent `performanceAlignerPlacesVoiceOnTheMusicItWasSungTo` passed this full run. No alignment fix was made or claimed. Its earlier original-main timing/queue reproduction remains in the first report.

Raw logs: `second-native-loading-red.log`, `second-native-loading-green.log`, `second-native-focused-green.log`, build logs, and `verification-second/native-ctest.log` under the task directory. Full CTest took 172.8 seconds.

## Additional read-only coverage

Reviewed media ownership/context transitions, decoder readiness/stop/seek/unload and worker cancellation, Wav/FLAC/Media Foundation decoder boundaries, SessionManager start/prepare/recovery/suspend/resume, application command parsing and lifecycle, native named-pipe and Unix control-server cancellation, device-notification ownership, and selected UDP endpoint/start-stop resource paths.

No additional patch was justified solely from unsupported or unverified scenarios. In particular, `SetPreviewLoop` is exposed natively but has no current renderer caller; loop persistence across arbitrary source replacement was not promoted into a speculative UI fix. Windows device notifications and actual backend/driver behavior cannot be proved in this Linux build. Unix endpoint behavior beyond the existing failure cannot be validated while stream sockets are denied. DSP, clock correction, rate/transpose processing, recording, analysis, and mixing algorithms were excluded from edits.

## Independent review

The desktop audit agent independently read the product diff, worker/generation interactions, and test. It found no regression blocker: rewind still executes, repeated Stop retains its intent, stale PCM remains excluded, and readiness is published by the existing worker. The test verifies frame availability rather than the first rewind sample; neighboring seek/generation tests cover the unchanged machinery.

No live Windows/Electron/audio-device completion claim is made. Automated tests do not satisfy the repository's required two-window live room/device gates.
