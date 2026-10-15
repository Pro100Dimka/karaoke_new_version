# Direct late recovery — physical evidence, 2026-10-15/16

**Physical live gate: FAIL. The task is not closed.** Host → laptop has three
unidentified mandatory timing cells and eight UNKNOWN active intervals. Reduced
absolute silence and a favourable listening observation do not satisfy that gate.
No timing threshold or room deadline policy was changed to obtain these results.

Tested native commit: `5beb7ed1e40b1960d51d5b30ec52c5de1c937983`
(runtime implementation `5e4f7964`, then a stricter fixture assertion).
Release executable SHA-256 on both PCs:
`9F1FEBB0CB17B96105BDC0312418BBF2B608DEAC21C67180FBA6B9E548D79BCE`.

## Final physical results

The original physical scenario and unchanged V2 analysis were repeated on two
real PCs: speaker → real microphone → normal direct voice → receiver master
with local backing. Reference is the real sender mic before codec/network;
residual is the exact simultaneous master minus backing. Monitoring OFF;
laptop Exclusive input 480 / Shared output, low-latency mic ON. Both rendered UI
gates passed; recording taps reported zero gaps, overruns and stale frames.

Capture A used room `fb264a80-fc78-4551-9c22-42114ad32d74`; capture B used
`f91a3950-a31d-4e63-bc9a-cdc77bf3c59e`. An unrecorded host-only playback during
inter-run preparation was rejected, both participants left through the UI, and
B started in a fresh room with the same devices and levels. This differs from
reusing one room; it is disclosed rather than counted as a valid intermediate
take. Both PCs ran their ordinary developer profiles through the existing
Electron launcher with the explicitly selected matching Release AudioService;
no second local profile or `start-multy` substituted for the laptop.

| Metric | Host → laptop | Laptop → host |
|---|---|---|
| Selected deadline during original Playing epoch | **57.5 ms**; server and both native 2760 frames | **50 ms**; server and both native 2400 frames |
| Approved 1 s mandatory cells, start / middle / end | **18/20, 19/20, 14/14 — FAIL** | **20/20, 20/20, 14/14 — PASS** |
| Accepted start / middle / end / median lag, ms | **Not accepted** | **50.003581 / 50.124512 / 50.094076 / 50.094076** |
| Minimum mandatory NCC, start / middle / end | .121593 / .179466 / .213493 | .385804 / .328304 / .622565 |
| Accepted drift, end minus start | **Not established** | **+0.090495 ms** |
| Voice relative to backing, median per window | Not accepted | 49.124660 / 48.993988 / 48.989052 ms |
| Classified missing source-component intervals ≥60 ms | 0 classified; **INDETERMINATE** | 0 in evaluated reference coverage; limitation below |
| UNKNOWN active intervals | **8; total 580 ms; longest 80 ms** | 0 classified; limitation below |
| Native active absolute-zero intervals ≥1 ms | 0 | 0 in evaluated reference coverage |
| Direct late-cut counter delta | **+297** | **+146** |
| Direct queue snapshot min / max, frames | 1194 / 2364 (27 snapshots) | 1046 / 2215 (25 snapshots) |
| Direct queue first → last; fitted slope | 2061 → 1980; +2.1463 frames/s | 2055 → 1742; −1.51695 frames/s |

Compact machine results: [A metrics](final-host-to-laptop-metrics.json),
[B metrics](final-laptop-to-host-metrics.json). Queue values are 5–8 second
snapshots, not continuous extrema. They do not establish audible continuity or
exclude all transient growth. B accepted middle cell range extends to 73.577 ms
(p90 64.748 ms); window medians are not a claim of constant instantaneous lag.

Strict 20 second NCC results remain FAIL: A **.153926 / .186770 / .111338**;
B **.203394 / .156077 / .191781**. B timing acceptance uses the user's prior
approval for unique 1 second cells within those same windows, retaining NCC ≥.2
and complete required voiced-cell coverage. No time-stretch or low-confidence
secondary estimate is substituted. [A strict result](final-host-to-laptop-strict-result.json),
[B strict result](final-laptop-to-host-strict-result.json).

### Exact A gate blockers

| Mandatory song cell, s | NCC | Separated second peak NCC | Active voice, ms |
|---|---|---|---|
| 32.000000 | .180440 | .075163 | 820 |
| 39.000000 | .121593 | .086503 | 720 |
| 73.607938 | .179466 | .068643 | 620 |

All three are below .2, with unique peaks and valid clock/reference coverage.
They are identification failures, not clock gaps or ambiguity failures. Accepted
A subcells cannot provide accepted overall lag or drift while these remain.

The eight UNKNOWN source-active intervals start at reported song seconds
38.03867 (60 ms), 38.91867 (80), 39.17867 (80), 70.47867 (60), 76.19867 (80),
85.39867 (80), 113.93867 (60), and 130.75867 (80). UNKNOWN means the expected
source component was not reliably identified; it does **not** prove PCM silence
or an audible dropout. Nonzero PLC does not prove recovery of the original phoneme.

The retained A direct trace contains **eight separate 96-packet windows**, about
240 ms each, not continuous coverage through the last source extent at 40.962125 s.
None overlaps the three failed mandatory cells or the first three UNKNOWN events.
Consequently PLC, retiming, late decisions or feedback cannot be assigned as their
cause. [Exact trace coverage and coordinate mapping](final-host-to-laptop-trace-coverage-limit.md).

Minimal native source/master/residual contexts with hashes:
[A UNKNOWN and failed-cell contexts](final-host-to-laptop-voice-contexts/manifest.json),
[B identified control](final-laptop-to-host-voice-contexts/manifest.json).
A wider clip's NCC never repairs a failed mandatory cell or reclassifies UNKNOWN.

### B coverage limitation

One preserved sender CSV row, WAV offset **2741280**, length **120 frames = 2.5 ms**,
has captureEnd−captureStart **−4 frames**. Effective source song 65.479104 s;
expected receiver 65.529104 s. It is outside all mandatory timing windows.
The unchanged whole-song classifier uses effective packet timestamps and reports
MEASURED/zero classified missing, but this does **not** verify that 2.5 ms physical
capture-clock span. The row was neither repaired nor silently discarded.

Additionally receiver WAV frames **0..160528**, **3.344333 s**, have no matching
sender reference: reported song 5.053226–8.397559, actual CSV presentation
5.074833–8.419104. This is before the sender reference recording, not post-EOF,
and outside all mandatory windows. Those samples are excluded from activity,
not counted as zero dropouts. B timing windows pass; a claim of fully verified
zero missing voice over every recorded sample would be incorrect.

The user reported **«Явных провалов не слышал»** for these two complete takes.
[Listening observation](final-observer-feedback.json) is separate from PCM gates.

## Before / after evidence and its limits

An unmodified `4b4f1895` full host → laptop baseline selected the same 57.5 ms.
It has **19 active zero intervals ≥1 ms**, total **267.4375 ms**, longest
**64.02083 ms**, versus zero such intervals in final A's evaluated active coverage.
Baseline direct cuts **+373**, final A **+297**. Baseline end timing was also
unaccepted (11/14 cells), with an additional 60 ms UNKNOWN interval.
[Baseline metrics](baseline-host-to-laptop-metrics.json),
[baseline source/residual contexts](baseline-host-to-laptop-voice-contexts/manifest.json).
These are separate physical takes on variable Wi-Fi, not identical arrival replay.

Historical user-reference A/B had longest zeros 92.667 / 156.625 ms and direct
cuts +828 / +195. Final A/B cuts +297 / +146 likewise cannot be converted into
audible dropout counts or attributed solely to the implementation. The earlier
**+1445 late cuts** was a packet-decision counter; its exact active/silent and
heard-dropout split was never captured. This gate does not invent that split.
Final A shows that hundreds of cuts can coexist with zero absolute active PCM
holes and still leave UNKNOWN expected voice; counters alone answer neither question.

## Implementation and real captured replay

The structural defects addressed were that receive-side concealment cannot run
while no datagram arrives, render FIFO starvation was zero-filled, and stale
late-decoded PCM could update concealment history before admission. The change
adds render-owned bounded continuity and remembers only admitted real PCM.
One shared loss budget covers queued loss and starvation: **20 ms continuation +
80 ms fade**, then silence; current PCM returns on its own timeline with ≤2.5 ms
recovery crossfade. Preallocated provenance tags share the existing PCM ring;
there is no extra audio queue or playout latency. The worker checks socket
readiness via **select → recv**, with a 2 ms readiness duration, not SO_RCVTIMEO.
Room/server timing, StableLatenessHistory, audio devices and frontend were unchanged.

Historical 92.667 / 69.250 / 156.625 ms gaps have exact WAV/CSV coordinates but no
per-packet arrival record. They constrain duration tests, not invented arrival patterns.
[Reproduction and limits](DIRECT_LATE_RECOVERY_TEST.md).

[Actual captured fixture](baseline-trace3-host-to-laptop-cut-burst.json): 96/96
exact real-mic PCM packets, sequences 22758–22853, observed 103019 µs socket gap,
13 QUEUE_LATE decisions. All receive/decision cursors join measured master block
ends: [join proof](baseline-trace3-host-to-laptop-cursor-join.json). Callback
execution times and raw rejected RX were not recorded; replay uses observed
arrival order and exact consumer milestones, not guessed callback wall times.

This short diagnostic take had server/sender 140 ms versus receiver **85 ms**;
it is not physical acceptance. Replay uses the observed receiver target 4080 frames.
The recorded master−backing has a 36.0625 ms zero interval near that burst:
[PCM coordinates](baseline-trace3-host-to-laptop-cut-burst-pcm-evidence.json).
After replay: **zero missing/longest-zero frames**, 96 packets, **13 cuts**,
max queue 3267, final queue 0, unchanged 85 ms target.
[Strict replay proof](strict-observed-replay-green.txt). The recorded baseline
is not an old-binary run through this same driver.

Duration-constrained old-render RED → new-render GREEN: **3 → 0 ms,
92.667 → 0 ms, 156.625 → 57.375 ms** absolute silence; recovery **2.479 ms**,
added latency **0**, drift **0 frames**, final queue **0**.
[Bounded-duration proof](directRenderContinuityBoundsSavedGapDurations-final-green.txt).
Silence reduction is not recovery of lost phonemes. Observed 13 late skips were
12.208–42.208 ms: a 2.5/5 ms reserve would rescue 0/13 packet ends in this snippet;
no reserve or timing change was introduced.

## Verification, cleanup and next check

AudioService Release on both PCs. Complete [CTest](ctest-final.txt): **5/5 PASS**,
459 native tests, 0 failures, **161.61 s**. Stricter captured replay assertions
then passed a focused rerun at the final test-only commit, with unchanged runtime.
Dedicated extractor tests **12 PASS**, with RED → GREEN logs. Full input paths,
SHA-256 and compressed unchanged analysis results: [FINAL_EVIDENCE.json](FINAL_EVIDENCE.json).

Both applications were closed through rendered UI and no owned Electron, Python
backend or AudioService process remains: [UI cleanup](final-ui-cleanup.json),
[host processes](final-host-process-cleanup.json),
[laptop processes](final-laptop-process-cleanup.json),
[auxiliary cleanup](final-cleanup-aux.json). Only this run's scheduled tasks and
SSH CDP tunnel were removed; unrelated tests/analysis processes were preserved.

**FAIL: the next specific check is why final A's three low-NCC cells and eight
UNKNOWN active intervals lose identifiable real-mic content.** Existing frozen
trace coverage cannot identify the responsible packet events. No further runtime
or room deadline change was made after these measurements.
