# Physical live gate V2 — 2026-10-15

**FAIL: current room timing is not accepted by this physical voice gate.**
The host → laptop recording at a selected deadline of 55 ms contains confirmed
loss of active microphone audio. Its required timing windows also contain
unidentified one-second segments, so no accepted lag or drift is reported for
that direction. No room timing, recovery, codec, driver or server policy was
changed to obtain this result.

## Code and physical setup

- Branch: `acoustic-optional-measure-play`; tested native code on both PCs:
  `4b4f1895ccc6cb3ec7c0ee11de00f6041fea6ac9`.
- Timing policy remains the policy of `660e8225`. Commits `5cf3f4e9` and
  `4b4f1895` add observation taps and dedicated tests.
- Host: Audient ASIO, 48 kHz / 64 frames. Laptop: Windows, exclusive microphone
  input 480 frames, shared output 480 frames, low latency microphone enabled.
- Real microphones, ordinary room UI, monitoring OFF, diagnostic input Disabled,
  no microphone WAV substitution. Receiver room microphone OFF; sender ON.
- Room: `1a7aef24-cc12-405a-b2d4-0809d569d47f`; song revision 2:
  `Мне 25 — Киньте Копеечку`, 161.216 seconds.
- Original [TEST_PLAN.md](../2026-10-15-physical-directional/TEST_PLAN.md) is
  unchanged. Reproduction and signal analysis are documented in
  [PHYSICAL_LIVE_GATE_V2.md](../2026-10-15-physical-directional/PHYSICAL_LIVE_GATE_V2.md).

## Authoritative final recordings

Use `ui-host-to-laptop-repeat-*` and `ui-laptop-to-host-repeat-*` only for the
final pair. Each capture stores UI URLs, control values, diagnostics on both
physical PCs and screenshots throughout the original playback epoch. Both PCs
must display the same karaoke song during that epoch. Post-song conversation
timing and a possible later playback epoch are excluded.

The sender `tap=network` is the actual mono 48 kHz PCM immediately before the
network encoder, after channel selection, capture conversions, DSP and gain.
The receiver saves final `tap=master backing=true`: the exact simultaneous
rendered backing has the same WAV indices as the audible backing + remote mix.
Their difference identifies the remote residual without stretching any waveform.
CSV sidecars preserve physical capture and actual output presentation room times.

The user explicitly approved unique one-second comparisons inside the original
20-second start / middle / end windows. NCC ≥ 0.2 and the separate-peak gate are
unchanged. The original fixed 20-second tests remain in `*-strict-result.json`;
they are not silently replaced with a PASS. An unaccepted segment, incomplete
window or unidentified active voice invalidates a timing/continuity acceptance.

### Host → laptop — selected deadline 55 ms

- Epoch: `2026-10-15T19:12:30.586955Z`; sender recording armed at song 4.58 s,
  receiver at 5.56 s, physical vocal enabled at 9.61 s.
- All required windows are fully recorded. Unique one-second timing accepted
  18/20 at start, 17/20 in the middle and 13/14 at end. Five segments failed
  NCC ≥ 0.2; one failed uniqueness. Active-voice coverage was respectively
  89.52%, 84.23%, 93.61%. **Start / middle / end / median / drift: not accepted.**
  Accepted-subset estimates in the raw analysis are diagnostics only.
- There are 44 native PCM silence intervals ≥ 1 ms during independently
  clock-mapped sender microphone activity, totaling 504.000 ms. Longest:
  92.667 ms. This engineering threshold is not a claim that all 44 were heard.
- Original-plan intervals ≥ 60 ms:

| Song position | Duration | Sender real-mic RMS | Residual maximum |
|---:|---:|---:|---:|
| 14.1002885 s | 92.66667 ms | 0.03526 | 2 PCM16 LSB |
| 128.7188094 s | 69.25000 ms | 0.02995 | 2 PCM16 LSB |

These are active source intervals, not natural pauses; output is attenuated by
at least approximately 54 dB. The two long gaps total 161.917 ms. Sender-active
scope is 57.98 seconds; the whole matched-component check also retains unresolved
active intervals as INDETERMINATE rather than declaring them continuous.
Both recording engines finalized their expected files with zero overrun, stale
blocks or recording gaps. This is real loss of the microphone component, not
recording failure or an inference from counters.

The unmuted, gain-1 direct stream added **828 late audio cuts** in the original
song. Muted `__room_server_mix__` counters are excluded. Packet cuts and the
44 measured waveform gaps have different units and cannot be substituted.

### Laptop → host

- Selected deadline **72.5 ms**, epoch `2026-10-15T19:16:12.901885Z`; receiver
  and sender armed before 3 s, physical vocal enabled at 7.01 s. Sender Music=0
  and Vocal=0 were verified before the quiet lead. Measured noise floor
  −80.17 dB; unchanged noise +10 dB rule gives −70.17 dB activity threshold.
- All required windows are complete; all 20/20, 20/20 and 14/14 voiced cells
  pass identification and backing confidence. Eleven initially ambiguous cells
  were resolved by unique 2 s context with the same NCC threshold; no stretching.

| Measurement | Start | Middle | End | Median |
|---|---:|---:|---:|---:|
| Physical real mic → receiver voice, ms | 72.563 | 72.670 | 72.659 | 72.659 |
| Minimum one-second NCC | 0.665 | 0.675 | 0.672 | — |
| Median one-second NCC | 0.952 | 0.915 | 0.945 | — |
| Effective voice relative to local backing, ms | 72.829 | 69.829 | 72.484 | — |

Physical drift = **+0.097 ms**, below the original 5 ms drift criterion. This
is an accepted timing measurement, not a claim of uninterrupted performance.
Strict fixed 20 s NCC remains 0.21272 / 0.18569 / 0.20766, so that separate
test retains FAIL.

- Source-active scope: 99.92 seconds; all active one-second identity contexts
  are identified, with no unknown context. This does not mean every PCM sample
  is present: the confirmed gap below remains a real loss.
- **One confirmed voice dropout:** song **105.4709087 s**, duration **156.625 ms**
  (7,518 native frames). Sender real-mic RMS is approximately 0.00554; all six
  receiver residual channels are within 1 PCM16 LSB. Its unique real-mic
  correlation context has NCC 0.71729, separate peak 0.12681. Total missing
  duration and longest dropout are both 156.625 ms. No natural pause is counted.
- Actual unmuted direct peer: **+195 late audio cuts** during this epoch.
  A counter interval around the gap adds 59 cuts. Muted server mix is excluded.
  Recording gaps/overruns/stale blocks are zero, and capture/XRun/bridge/music
  error counters do not increase across the loss. **Physical continuity FAIL.**

The final [A metrics](ui-host-to-laptop-repeat-metrics.json),
[B metrics](ui-laptop-to-host-repeat-metrics.json) and
[cut comparison](cut-summary.json) keep confidence and waveform losses distinct.
Auditable source/master/residual clips are listed in
[A manifest](FINAL-A55-voice-contexts/manifest.json) and
[B manifest](FINAL-B72-5-voice-contexts/manifest.json). Subjective audibility of
every short event was not claimed; these are measured missing microphone PCM.

## Earlier takes and methodological corrections

- Earlier recordings rejected after the user reported different pages during
  the song are not final UI evidence.
- `ui-host-to-laptop` maintained correct pages but its master began at song
  20.200668 s, omitting part of the mandatory first window. It additionally
  contained 13 source-active gaps totaling 562.771 ms, longest 68.229 ms;
  two were ≥ 60 ms. It is additional loss evidence, not accepted timing.
- `ui-laptop-to-host` had good unique timing but its intended quiet lead still
  played backing from the sender speaker because a UI level command had not
  completed. Its noise calibration therefore cannot certify continuity. It was
  repeated with both role controls verified before recording. No threshold was
  reduced to compensate.
- A physical microphone reference need not outperform the studio stem in every
  long fixed-phase window. On the same real 1 s excerpt at song 25 s in the
  earlier UI reverse recording, real-mic NCC was 0.9950007 (separate peak
  0.1125678), versus studio-vocal NCC 0.5948496 (separate peak 0.0695148).
  This is the same residual and unchanged 300–3400 Hz band/NCC search. Existing
  packet retiming can vary PCM phase inside a long window; no time stretch is
  used by the approved local comparisons.
  The auditable same-excerpt comparison is saved in
  [reference-comparison.json](reference-comparison.json) and
  [reference-comparison.png](reference-comparison.png).

## What the historical +1445 meant

The old +1445 belonged to the actual unmuted direct host voice on the laptop,
with gain 1, during Playing; it was not a muted server-mix counter. Its
`NonzeroVoice` label tests nonzero packet amplitude and also includes microphone
room noise. It means 1445 rejected 120-frame packets, not 1445 audible dropouts.
The old recording lacks the exact sender reference needed to retrospectively
partition those packets into active singing and quiet/noise. The new real-mic
recordings prove that at least some late rejection really does remove active
audio; they do not invent a retrospective audible-loss duration for the old take.

## Automated verification

Host and laptop AudioService Release builds passed. At tested native source
`4b4f1895`, the complete native suite contains 440 registered tests and CTest
passed 5/5, 0 failures, 163.89 seconds. See [ctest-final.txt](ctest-final.txt) and
[AUDIOSERVICE_TAP_TESTS.md](AUDIOSERVICE_TAP_TESTS.md) for dedicated RED → GREEN
proof and realtime tap instrumentation. The final offline analysis suite passed
29 tests in 21.94 seconds: [analyzer-test-green.txt](analyzer-test-green.txt).
No Python room contracts or frontend implementation were changed by this work.

## Saved evidence and cleanup

[FINAL_EVIDENCE.json](FINAL_EVIDENCE.json) contains the final playback epochs,
continuous two-PC UI observations, native configuration, RTT summaries and
SHA-256 hashes of the exact recordings, CSV sidecars, screenshots and analysis
files. Large full-song recordings remain in this artifact directory; the
versioned excerpts and metrics preserve the relevant proof.

During the final songs, both PCs kept the same karaoke page, with stable role
levels and no modal. Representative middle screenshots:
[A host](ui-host-to-laptop-repeat-host-74s.png),
[A laptop](ui-host-to-laptop-repeat-laptop-74s.png),
[B host](ui-laptop-to-host-repeat-host-67s.png),
[B laptop](ui-laptop-to-host-repeat-laptop-67s.png).
Both directions' complete timestamped screenshot sets are indexed by the manifest.
After recording, music/mic gains were restored to 100%, original-vocal gain to
0%, room microphones enabled and monitoring left OFF. Both test applications
were closed. [cleanup-summary.json](cleanup-summary.json) confirms zero owned
Electron/Python/AudioService processes on both PCs and no remaining launch
wrapper or UI SSH tunnel. No release or push was performed.

## Decision and next cause

**FAIL.** At 55 ms, an active microphone signal is actually absent from the
receiver output for intervals up to 92.7 ms. Some mandatory timing segments also
remain below the unchanged confidence gate; no secondary lag or zero-drift claim
is substituted. The next focused cause to address is loss of active direct-route
voice at the fixed deadline, with the saved gap timestamps and packet diagnostics
as evidence. This run makes no server/margin/recovery change and does not accept
50–55 ms for both physical directions.

The final selected pair was 55 / 72.5 ms under the unchanged client/server policy;
it was not manually forced to the earlier 50–55 ms range. At 72.5 ms the reverse
direction also loses an identified active voice interval for 156.6 ms. The next
investigation therefore concerns the direct late-cut/recovery path during packet
stalls, using these exact loss coordinates. There is no reason from this gate to
reopen capture drivers or substitute a server timing change.
