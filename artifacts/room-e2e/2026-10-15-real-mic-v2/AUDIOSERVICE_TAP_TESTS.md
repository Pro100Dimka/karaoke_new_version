# AudioService physical-reference instrumentation checks

Date: 2026-10-15, Europe/Kiev. Baseline: `660e8225`.

No deadline selection, stable-history formula, server policy, device period or DSP algorithm was changed.

## Test-first evidence

Before implementation, `networkReferenceRecordsTheActualPreCodecMicrophone` was added and compiled in `AudioService/build` Release (the separate `build-release` tree has `AUDIOSERVICE_BUILD_TESTS=OFF`). Running it on the baseline implementation exited 1 with 12 failed expectations: no transport-rate mono reference recording and no timestamp sidecar rows. Existing `tap=network` fell back to RawInput, which records only after render; the test deliberately captures and sends before any render.

Before adding master timestamps, `masterRecordingTimelineUsesActualPresentation` exited 1 with 2 failed expectations: absent CSV header and absent exact presentation anchor.

The lifecycle test then exposed an open timeline writer after controlled recording failure: `recordingTimelineClosesWithLifecycle` exited 1 with `failure closes the timeline writer`. Cleanup was added to prepare/failure/worker failure/finalization paths, then the test passed.

## Final focused results

`cmake --build AudioService/build --config Release --target audioservice_tests --parallel 4` exited 0. All four focused commands exited 0:

- `networkReferenceRecordsTheActualPreCodecMicrophone`: capture at both 44.1 and 48 kHz; physical channel 1 selected from stereo input; six render channels; microphone gain 0.5; actual capture DSP; monitoring off; no render callback; saved mono 48 kHz reference equals the actual UDP PCM source after normal PCM quantization; each CSV row matches the effective packet timestamp and its distinct physical capture interval. A 12 ms acoustic correction proves capture coordinates are separate from effective musical timestamps. Capture instrumentation reports no realtime allocation, blocking call, disk I/O or network I/O.
- `masterRecordingTimelineUsesActualPresentation`: WAV sample zero maps to scheduled output presentation in the room clock, independent of the time of `StartRecording`.
- `networkReferenceRetainsTheCaptureSpanAcrossBlocks`: one packet spanning two physical capture blocks retains the end timestamp of the final consumed block, including a small source timestamp move.
- `recordingTimelineClosesWithLifecycle`: prepared master to legacy tap, controlled failure, retry and successful finalization all close/reopen the sidecar appropriately.

An initial full suite run progressed through existing tests without reported assertion failures, then stopped producing output at `serverMixDeadlineNeverDelaysTheLocalBackingTrack` with unchanged process CPU for more than 90 seconds. The owned test process PID 21108 was terminated. The same test, run in isolation immediately afterward, passed in approximately 6 seconds. This is an interrupted full run, not a full-suite pass and not proof of a pre-existing issue. Root agent will run the final required complete suite after the focused handoff.

## Recording API and timeline semantics

Sender: existing `PrepareRecording|id=...|path=...|tap=network`, `StartRecording`, `StopRecording`. This is an observation tap immediately before codec encode in `NetworkAudioEngine::sendMain`, after physical input channel selection, capture DSP, microphone gain, mono normalization and ordinary transport-rate conversion. It does not generate, replace or inject microphone PCM.

Receiver: existing `tap=master`; this saves the final backing + remote mix before the external Windows-volume scalar, matching the existing master semantics.

Both selected taps write `<wav path>.timeline.csv` using the existing recording worker. CSV columns:

```text
wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz
```

`sampleRateHz` is the WAV rate. Every timeline field has the separately declared `timelineSampleRateHz=48000` room-clock units. Network `timelineFrame` is the effective packet timestamp actually encoded in its header, with the shared flag removed. Its capture fields are physical input first/end timestamps before `voiceSungAt` corrections; these are propagated with source block offsets through normal conversion. Master `timelineFrame` is the first output sample's scheduled device presentation; its capture fields are unused (zero).

`roomClockValid` requires a configured room clock and valid physical capture timestamps, or a nonzero master presentation timestamp. A network packet that is cut at a genuine source gap and padded with silence is marked invalid for capture-span interpolation. Missing/invalid rows, overrun/gap/stale metadata or insufficient coverage must invalidate the affected measurement, not be treated as zero delay.

The legacy recording start/stop session metadata remains in its local command/render coordinate domain. Use CSV timestamps for cross-PC physical lag; do not subtract the two PCs' local session frame counters.

## Exact simultaneous rendered-backing companion

The first physical trial established that subtracting a separately decoded 44.1 kHz project stem from a 48 kHz master leaves too much backing because its waveform does not follow the exact live source conversion. A diagnostic companion was therefore added without changing source rendering, room scheduling, device configuration or deadline policy.

API: `PrepareRecording|tap=master|backing=true|path=<master.wav>` additionally creates `<master.wav>.backing.wav`. Its WAV rate, channels, sample zero, admitted blocks and overrun silence are identical to the master. The master CSV applies to both files. The backing contains the exact gain-scaled music already rendered into this callback, including actual source conversion, song loudness, music gain and master gain. It excludes the separately mixed remote voice and guide vocal.

Buffer 5 is reused after RawInput/analysis have copied its earlier microphone data. The callback snapshots the rendered backing there before the performance aligner overwrites buffer 3. A second bounded PCM ring and WAV writer reuse the existing recording worker and common block descriptor. Both rings' capacity is checked before either stream is admitted; a descriptor publishes the pair only after both pushes. Any recording overrun inserts silence at the same offsets in both files. If prepare/start races an unstaged first block, neither member is admitted; the first complete pair receives the first CSV anchor. The optional feature is disabled for existing recording callers.

Test-first result: `masterCompanionRecordsTheExactRenderedBacking` was added and compiled before implementation. It exited 1 because the optional companion WAV did not exist. After implementation, it passes: a 44.1 kHz backing is rendered through the actual 48 kHz playback path with music gain 0.4 and master gain 0.5, while a known remote waveform enters the ordinary remote queue, DSP and remote gain 0.7. The companion equals the audible master minus that processed remote voice within normal PCM16 quantization tolerance (5e-5); master and companion have equal duration/rate/channels. Capture/render instrumentation shows no realtime allocation/deallocation, blocking, disk, socket or IPC operations.

`masterCompanionSharesOverrunsAndLifecycle` passes: a forced oversized pair produces the same eight silence frames in both files; the following accepted pair stays sample-aligned; one shared overrun/gap is reported; success and failure close the companion; the next ordinary master prepare returns to the original single-WAV behavior. Existing focused network-reference and master-presentation tests pass after this extension. Root owns the final Release rebuild/full-suite run and physical verification.

## Final native build and automated verification

The final native instrumentation commit is `4b4f1895` (`feat(audio): pair master diagnostics with exact rendered backing`). The saved [build-final.txt](build-final.txt) records the host Release build of AudioService, AudioControl, NativeVoiceRelay and the test executable. [laptop-build-final.txt](laptop-build-final.txt) records the matching laptop Release build, including its AudioService and test executable. The final registered native suite contains 440 tests. The saved [ctest-final.txt](ctest-final.txt) reports the complete `audioservice_tests` executable PASS in 162.67 seconds and CTest **5/5 PASS**, zero failures, total **163.89 seconds**, including both WASAPI latency-script checks and the runtime-install check. These final results supersede the interrupted initial full-suite attempt described above; that interruption is not labeled a pre-existing issue. Later artifact-only analysis and reporting edits require no native rebuild or test repetition. Automated success remains a prerequisite for the separately documented physical UI gate, not a substitute for it.
