# PCM provenance audit — 2026-10-19

Scope: source inspection, automated coverage and an optional diagnostic queue-span output. No audio policy, queue operation or PCM behavior changed. Low NCC is not evidence of a provenance bug. The physical gate remains separate.

## Ownership and publication

- `PcmRingBuffer` allocates one optional byte per frame in `prepare`. PCM and its tags are copied before the same release publication of `writeFrame_`; pop acquires that publication and advances the same `readFrame_`. A tag describes an interleaved frame, not an individual channel sample.
- Push is all-or-nothing. Capacity and input-length checks precede either PCM or tag writes. Pop rejects an undersized PCM or tag output without consuming frames; an underfilled pop copies only available frames. `discard` advances the shared frame index. `clear` drains current users before moving read to write and increments the queue epoch; `prepare` resets both indices and tag storage while stopped.
- Current network tags are **0** for PCM Lost/initial silence and **1** for delivered real audio or usable Opus PLC (`usableDecoded` is a boolean converted to `uint8_t`). There is no distinct runtime tag 2 for Opus PLC. The ring supports arbitrary byte tags, but its numeric tags must not be described as a richer runtime provenance taxonomy.
- The render owner handles tag-0 queue frames and FIFO starvation through the same `PcmPlayoutConcealer`. Only consumed usable runs seed/reset that render history. Merely queuing a future real packet cannot reset the missing duration. Queue epoch changes and explicit mute reset render continuity.
- Receive-side PCM history is committed only after successful queue admission in both normal and retimed paths (`pcmLossConcealer.remember`). Fully late packets and failed queue pushes bypass both calls. `smoothRecovery` previews decoded PCM before admission, but does not mutate the history/recovery state; only `remember` commits it. The decoded `packetPeak` is measured before that preview.

## Existing network regression coverage

| Requirement | Existing test |
|---|---|
| Previewing rejected PCM does not consume recovery | `pcmRecoveryPreviewDoesNotCommitAnUnqueuedPacket` |
| Bounded per-channel receive concealment | `pcmConsecutiveLossHasAFiniteEnvelopeForEveryChannel` (1, 2, 6 channels) |
| Render starvation has a finite tail; real PCM resumes at its original position | `directRenderContinuityBoundsSavedGapDurations` |
| Mute and queue epoch reset cannot leak an old tail | `directRenderContinuityCannotLeakAcrossMuteOrQueueReset` |
| Expired UDP backlog is cut; first current PCM preserves phase, queue and deadline | `directRenderContinuitySurvivesSocketSilenceAndRejectsStaleBacklog` |
| Fully late and queue-full rejected real packets cannot seed receive concealment | `rejectedPcmPacketsCannotSeedReceiveLossConcealment` |
| Consecutive queued PCM Lost remains finite and real recovery is phase-correct | `directConsecutiveSequenceLossUsesBoundedContinuity` |
| Queued PLC then starvation shares one 100 ms budget | `directMixedLossCannotRestartTheContinuationBudget` |
| Future queued REAL does not reset budget before consumption | `queuedFutureVoiceCannotResetAnUnconsumedLossBudget` |
| Starvation then queued PLC then starvation shares that same budget | `queuedLossCannotEraseAnEarlierStarvationBudget` |
| Healthy queued REAL is not attenuated as synthetic loss | `directSteadyQueuedRealVoiceCannotBecomeConcealment` |
| Missing positions expire only after their presentation horizon; late original is rejected | `sharedVoiceReorderPreservesTimelyPacketsAndPumpsMissingOnes` |
| Already readable originals precede timer-only missing decisions | `sharedVoiceReadsReadyDatagramsBeforeExpiringMissingPositions` |
| Recorded 96-packet arrival fixture | `observedDirectPacketBurstKeepsBoundedPlayoutContinuity` |

The stale-backlog test proves queue rejection and current phase recovery. The additional `rejectedPcmPacketsCannotSeedReceiveLossConcealment` now directly checks receive concealment after both fully late and queue-full real packet rejection; it passes in `rejected-history-green.txt`. The identified coverage gap is therefore closed without a production audio change. Automated/source evidence does not establish physical packet classification at the remaining low-NCC cells.

## Added coverage (tests only)

`AudioService/tests/realtime/PcmRingBufferTests.cpp`:

- `pcmRingSourceTagsFollowPartialMultichannelOperations`: sequential table on 1/2/6 channels; partial pop crossing tag boundaries; non-power-of-two wrap; discard; rejected overflow; short input, output and tag span; underfill; untouched output tail; clear and prepare reset. Checks frame count, capacity and every sample/tag pair after each relevant step.
- `pcmRingSourceTagsPublishWithPcmAcrossThreads`: SPSC 70,000 frames through a 17-frame queue; 7-frame tagged writes and varying 1–9-frame reads, with exact frame/channel values and per-packet tags. Uses no sleeps or timing assumptions. RT scopes cover only push/pop and assert no allocations, frees or blocking calls.

These two tests are coverage additions for existing behavior, not a claimed bug fix. Root built and ran both successfully while checking the diagnostic API RED state.

## Diagnostic admission-to-render spans

An optional `PcmRingBuffer::Transfer*` output adds `{epoch, firstFrame, frames, valid}` to the existing push/pop calls. It reports the absolute write/read cursor captured inside the same existing publication lease. Failed calls invalidate the entire output; a valid empty read retains the current cursor with zero frames. `clear` changes the epoch and keeps the monotonic write origin; `prepare` changes the epoch and restarts storage at frame zero. The diagnostic output adds no allocation, mutex, queue operation or change to existing PCM/tag publication.

Dedicated regression: `pcmRingTransfersIdentifyExactQueueSpans`. A compilation-compatible stub always returned an invalid transfer while preserving PCM operations. Root's `native-red.txt` records 15 failed span expectations, with the two tag regressions passing. Only then was the transfer output implemented. GREEN is recorded in `native-first-green-gain-red.txt` and the completed `native-full-release.txt`.

## Trace-only IPC control

`SetDiagnosticRoomInput` reuses its existing `AD_VOICE_ROOM_E2E=1` guard and handles `packetTrace=start|stop|export` before parsing any microphone, WAV, pilot or requested-delay arguments. This is an engineering recording control only. `start` prepares trace storage once, `stop` drains trace producers, and `export` requires a stopped capture and explicit `tracePath` prefix. Unknown actions and export exceptions return `InvalidRequest`.

Dedicated regression: `ipcPacketTraceControlNeverReplacesTheMicrophoneOrDelay`. Root's `ipc-red.txt` records 20 failures with the original input-control fallthrough. The test verifies the environment guard; intentionally invalid input/tone arguments on trace-only start/stop; unknown mode; active export rejection; empty prefix; filesystem error handling; four exported CSV files; and the unchanged microphone report and four network-delay values after every command. The early trace branch was added only after that RED run. GREEN is recorded in `ipc-green.txt` and the completed `native-full-release.txt`.
