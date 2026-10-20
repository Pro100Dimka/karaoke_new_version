# Direct packet trace physical gate — 2026-10-19

This is the repeatable engineering procedure for the remaining host → laptop
voice-identification failures. It adds continuous observational trace and fixes
one offline lag-search defect. It does not change the physical scenario, room
deadline policy, StableLatenessHistory, PLC budget/fade, reorder capacity, codec,
audio device settings, calibration or backing timeline.

The original [TEST_PLAN](../2026-10-15-physical-directional/TEST_PLAN.md) and
[PHYSICAL_LIVE_GATE_V2](../2026-10-15-physical-directional/PHYSICAL_LIVE_GATE_V2.md)
remain authoritative and unchanged. Use **two physical PCs**, their ordinary
developer profiles and the rendered UI. Do not substitute two profiles on one
PC or diagnostic WAV injection. Room-control API calls are not a physical UI
gate. Diagnostic commands below only record evidence.

## Freeze and identify the build

From `D:\Git\karaoke_new_version`, save `git status --short`, branch, full HEAD,
the relevant diff and the SHA-256 of the actual AudioService executable on both
machines. Preserve unrelated changes. Laptop SSH is `pro10@192.168.0.194`; its
repository is `C:\Users\pro10\Documents\karaoke_new_version`.

Build Release and pass the complete AudioService suite before the physical
take. Do not rebuild or run FFT analysis, tests or large file transfers during
the take. The native instrumentation is observational: its enabled/disabled
regression requires identical rendered PCM, unchanged queue position and no
realtime allocation/blocking/file I/O.

Launch one normal developer application on each PC with the same verified
native build. Set `AD_VOICE_ROOM_E2E=1` **before creating AudioService**. The
existing `AD_VOICE_ROOM_PACKET_TRACE=1` may also remain enabled for old compact
diagnostics, but it is not the continuous trace. Set the normal launcher
`AD_VOICE_AUDIO_SERVICE` to the exact executable whose SHA was saved. Use the
existing ordinary dev launcher with `--remote-debugging-port=9351`; the
repository entry point is `frontend/scripts/start-electron.mjs`.

For the laptop, preserve its existing low-latency microphone ON configuration,
Exclusive input period 480 and Shared output. The existing launcher can retain
`AD_VOICE_WASAPI_DIAGNOSTIC_EXCLUSIVE_INPUT_PERIOD_FRAMES=480`. Main PC keeps its
working audio mode. Both use real microphones. Confirm these values from both
native diagnostics; do not reconfigure the devices to obtain a preferred result.

The capture helper expects CDP host `127.0.0.1:9351` and laptop via local
`127.0.0.1:9352`. Use an SSH tunnel equivalent to
`ssh -N -L 9352:127.0.0.1:9351 pro10@192.168.0.194`. If starting a background
helper through PowerShell, use `Start-Process -WindowStyle Hidden` and retain
its owned PID for cleanup. Laptop `ac.bat` must call AudioControl against
`\\.\pipe\ADVoice.AudioService.Dev.v1`; the host helper sets that pipe itself.
Confirm `GetDiagnostics` addresses the intended process before recording.

## Physical preparation and start

Use the same song, **Мне 25 — Киньте Копеечку**, project
`252c8e32-5654-48fd-b64b-09d2cac55640`, revision 2, about 161.216 s. If the
project/revision differs, save the actual identity and use its true references;
do not silently correlate against these old stems.

Create/join the ordinary room through the two rendered UIs. Before starting,
both must be stable on the Library page and the server must be Stopped. A
host-only song page while laptop remains in Library is an invalid take: stop
through UI, restore both pages and repeat from the beginning.

For host → laptop:

- Host is the physical sender: Music 0, Vocal initially 0, Mic 100%, room mic ON.
  The helper changes Vocal to 100% after the quiet lead. Studio vocal sounds
  from the host speaker into its genuine microphone.
- Laptop is receiver: Music 100%, Vocal 0, room mic OFF. Its own mic must not
  enter the received mixture. Remote participant gain stays 100% on both PCs.
- Monitoring OFF on both. Leave physical loudness and all controls unchanged
  throughout the song. `OutputHardwareMute` is a hardware capability flag,
  **not** the current Windows mute state.

Before recording, require identical project page/readiness on both PCs and
agreement between selected server deadline and both native room deadlines.
Save the actual selected value and source; do not force 57.5 or 50 ms through a
diagnostic override. Those were prior measured selections, not new constants.
Use literal IPv4 direct endpoints from the room. Save endpoint/participant
mapping and confirm direct route diagnostics. Keep the original source signal
and mic path; no `filePath`, enabled diagnostic input or artificial tone.

Create a unique run directory inside the repository and a new label. Example
from the repository root, replacing `ROOM_UUID` and the label:

```powershell
$env:AD_VOICE_EVIDENCE_DIR = 'D:\Git\karaoke_new_version\artifacts\room-e2e\2026-10-19-direct-packet-trace\take-01'
$env:AD_VOICE_SAVE_FULL_PACKET_TRACE = '1'
$env:AD_VOICE_SAVE_PACKET_TRACE = '1'
New-Item -ItemType Directory -Force -Path $env:AD_VOICE_EVIDENCE_DIR | Out-Null
node artifacts/room-e2e/2026-10-15-real-mic-v2/capture-run.mjs ROOM_UUID host-to-laptop trace-host-to-laptop-01 165 start
```

The helper mirrors this repository-relative directory on the laptop. It arms
both continuous traces **before the UI start**, starts the song through the
host rendered song card, waits for both karaoke pages and checks role levels,
mic state, Monitoring OFF and settled user-recording state. It records:

- Sender `tap=network`: real selected/conformed microphone signal immediately
  before network encoding, plus its `.timeline.csv` physical/effective spans.
- Receiver `tap=master backing=true`: final master and its exact simultaneous
  `.backing.wav`, plus master `.timeline.csv` presentation spans.
- A 3 s quiet mic lead, then physical source Vocal ON through UI.
- Room/native diagnostics about every 5 s, UI screenshots about every 30 s,
  UI project/role guard and command/reply timestamps in `*-evidence.json`.

The old 96-event rearm command is deliberately skipped in full-trace mode.
The helper stops and exports continuous trace in `finally`, including on UI
failure. Any trace start/stop/export error makes the run fail. A UI failure can
still leave diagnostic WAV recording active; inspect and finalize both taps
before cleanup. A partial or failed take remains evidence, not acceptance.

Laptop WAVs are saved under `C:\Users\pro10\<label>-...wav`; trace CSVs are
saved in the mirrored repository directory. After recording has finished,
copy the laptop WAV, backing companion, timeline sidecar and all four trace
CSVs to the local take directory. Preserve originals and SHA-256 manifests.

## Continuous trace control and storage

For manual recovery/inspection of the helper, these are the exact AudioControl
arguments, with the proper Dev pipe and actual local path on each machine:

```text
SetDiagnosticRoomInput packetTrace=start
SetDiagnosticRoomInput packetTrace=stop
SetDiagnosticRoomInput packetTrace=export tracePath=D:\...\take-01\label-main-packet-trace
```

These branch before tone, microphone, WAV and requested-delay handling and
leave those states unchanged. The existing E2E environment guard applies.
Unknown actions, active export, empty export prefix and export exceptions
return `InvalidRequest`. Start prepares storage once if needed; subsequent
start resets that trace take, so never rearm over unexported evidence.

`VoicePacketTrace` has three append-only, single-producer lanes:

| Lane | Current maximum events | Producer |
|---|---:|---|
| Sender | 131072 | send worker |
| Receive | 1048576 | receive worker, socket/reorder/decision events |
| Render | 524288 | render owner, per active participant |

Allocation occurs on the control thread at preparation. Append copies a fixed
event into preallocated storage, without allocation, mutex, wait, formatting or
file I/O. Render measurements are bounded scans of the current PCM block.
Overflow increments an explicit counter and retains earlier evidence; it never
overwrites the beginning of the song. Stop drains append writers on the control
thread. CSV export happens only while stopped. Never export during singing.

For this procedure use one arm before the song and one stop after the song.
The engine captures a lifecycle token before assembling each event and append
checks that token inside its producer lease. A delayed event from the preceding
take therefore cannot enter a rearmed take. A dedicated token regression was
RED before that correction and GREEN afterward. Direct endpoint metadata is
resolved/cached on the control thread, not resolved again by each traced send.

Export writes `<prefix>.sender.csv`, `.receive.csv`, `.render.csv` and
`.status.csv`. Require `prepared=1`, `active=0`, `complete=1`, nonzero expected
lane counts and all overflow counters zero. `complete=1` only means a stopped,
armed, non-overflowed trace; independently verify actual song/cell coverage,
WAV coverage, valid clocks and UI gate. It is not an automatic physical PASS.

Current ordinary diagnostics also expose `FullPacketTraceActive`, `Epoch`,
`SenderEvents`, `ReceiveEvents`, `RenderEvents` and the three overflow counters
under their `FullPacketTrace...` field names. Save raw diagnostics as well as
parsed summaries, because the legacy short trace uses repeated keys.

## Schema and exact joins

CSV headers are the versioned-by-source schema: preserve them and save HEAD,
instrumentation diff and native hash rather than guessing column positions.
The exact definitions are in `AudioService/src/network/VoicePacketTrace.hpp`
and export code in `.cpp`.

- **Sender:** participant key, local generation, stream epoch, sequence, codec,
  physical capture first/end and effective media frame, capture validity/gap,
  source/transport frame counts, PCM FNV hash/energy/peak/zero frames, encoded
  payload hash, encode/send begin/end times, direct endpoint and send results.
  The current sender event has one direct destination/result field: this gate
  uses exactly one remote physical peer. Do not call it per-destination send
  evidence for a multi-peer room; that field would describe only the last peer.
- **Receive SOCKET:** valid decoded header identity, socket/processing clocks,
  room frame at arrival, actual source endpoint, direct/relay flag and wire/
  payload hashes. Includes self echo, wrong session, duplicate and unknown-peer
  rejections. Malformed/short datagrams are not valid voice packet events.
- **Receive REORDER:** accepted/late/duplicate/overflow/rebase outcome. Do not
  count an intentionally duplicated direct/relay copy as a missing source packet.
- **Receive DECISION:** REAL / PCM_LOSS / OPUS_PLC / NONE, decode frame count,
  horizon, target delay, due distance, queue fill, partial late skip, input offset,
  corrected output length, admission result and exact queue span. Lost metadata
  has no physical arrival; zero arrival times must not be called a real receipt.
- **Render:** participant/generation, output presentation timeline, exact consumed
  queue span, received tag counts, FIFO starvation, concealment age/recovery,
  mute/reset and before/after PCM hash/energy/peak/zero frames. `after` includes
  participant effects and participant gain. It is that participant's contribution
  before summing into the master; the final master/residual WAV remains required.

Cross-PC packet identity is participant key + stream epoch + sequence, checked
against effective frame and encoded payload hash. Generation is local to a
process; do not require unrelated PC generations to be equal. Wire hashes can
differ because relay/direct headers differ. FNV is a deterministic content join,
not an authentication proof. All clocks/frames must retain their declared units:
effective/capture media and receive horizon are 48 kHz protocol frames; native
queue/render frames use that receiver's configured rate. Delay fields from the
receiver are native frames. The present physical configuration is 48 kHz on both.

`PcmRingBuffer::Transfer` supplies `{epoch, firstFrame, frames, valid}` from the
same lease/cursor publication as PCM. Join admitted `[firstFrame, firstFrame+
frames)` to overlapping render spans with identical participant/local generation
and queue epoch. This survives non-power-of-two wrap, partial pop, late prefix
skip and retiming. Clear changes epoch and retains the monotonic write cursor;
prepare changes epoch and restarts storage. A valid empty pop provides a
starvation cursor; an invalid transfer is not a rendered interval.

Queue tag **0** means PCM Lost/alignment silence; tag **1** means delivered REAL
**or existing Opus PLC**. It is not a three-valued runtime marker. Distinguish
them by joining the DECISION `decodedKind` and queue span. Initial alignment
padding has `NONE`, not REAL or missing sung voice. Queued PCM loss and empty
FIFO use the same existing bounded render concealment budget; future unconsumed
REAL does not reset it. Nonzero PLC does not restore missing phonemes.

## Audio analysis and unchanged confidence gate

Use the real sender mic as voice reference. Keep the studio vocal only for
optional comparison/source playback. Require the exact simultaneous backing
companion with identical native frame count/rate as master. Calculate native
`residual = master_channel - paired_backing_channel`; do not fit the studio
vocal to the residual. Align the local backing stem separately to establish
song position and voice-to-backing skew. No artificial time stretching.

The existing analyzer applies DC removal and 300–3400 Hz voice band-pass at
8 kHz, with ordinary resampling to a common rate. One proven offline defect is
fixed in [analyze_real_mic.py](../2026-10-15-real-mic-v2/analyze_real_mic.py):
integer 8 kHz lag positions could miss a narrow NCC peak. It now interpolates
the **already filtered** voice arrays at a constant 6× ratio and searches all
main and competing peaks on that grid, then maps the lag back. The source
waveforms' relative duration/rate, polarity rule, backing's 4 kHz search,
window selection, 50 ms separated-peak rule and **NCC ≥ 0.2** remain unchanged.
Refining only the winning coarse peak would hide ambiguous competing peaks;
the dedicated repeated-occurrence regression guards against that.

Create a take-specific config following the existing
`../2026-10-15-direct-late-recovery/final-host-to-laptop-config.json`, replacing
all WAV paths, `renderedBacking`, `songStartRoomFrame`, song anchor and actual
vocal-on derivation from that take. Use the first 1.5 s quiet mic for noise;
do not reuse an old UTC/song origin. CSV physical spans supply mic capture and
receiver presentation time piecewise; no global-clock extrapolation through
invalid or missing spans. Execute offline, after capture:

```text
python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/analyze_real_mic.py TAKE_CONFIG.json STRICT_RESULT.json
python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-15-real-mic-v2/diagnose_real_mic_windows.py TAKE_CONFIG.json STRICT_RESULT.json APPROVED_1S_RESULT.json 1
```

Keep strict 20 s results as well as the user-approved mandatory 1 s cells inside
start 20–40 s, middle 70.6–90.6 s, end 121.2–141.2 s. Every required voiced cell
must satisfy the same gate and clock/coverage checks. Context may disambiguate
occurrence but may not replace a failed cell with a neighbour or several good
20 ms pieces. If any mandatory cell fails, overall lag/drift is unaccepted.

Compute physical lag from identified sender capture to receiver presentation,
and voice-to-backing position separately. Report start/middle/end/median and
`drift = end lag - start lag` only after all mandatory windows pass.

## Packet classification and missing voice

Inspect the three originally specified cells at 32.000000, 39.000000 and
73.607938 s and the eight coordinates 38.03867, 38.91867, 39.17867, 70.47867,
76.19867, 85.39867, 113.93867 and 130.75867 s. Retain exact native WAV frames and
piecewise CSV clock mapping, not only rounded song seconds. For the new take
also classify every newly detected weak/missing active interval.

For each expected sender-active packet/frame span, follow sender → SOCKET →
REORDER/DECISION → admitted queue span → render span → final residual. Save a
machine-readable per-packet table, counts and frame-duration totals:

| Category | Required evidence |
|---|---|
| NETWORK_NOT_ARRIVED | Sender packet exists; continuous receiver coverage contains no matching valid receipt, including duplicate copies |
| ARRIVED_AFTER_HORIZON | Matching receipt/decision exists but its playable position has already passed the actual render/admission horizon |
| EARLY_REJECT | Valid eligible packet rejected while its playable position was still available; retain exact horizon/queue state and reproduce before alleging a runtime bug |
| ADMITTED_REAL | DECISION REAL with successful queue insertion and exact span |
| PLC | Missing source position covered by PCM_LOSS, OPUS_PLC or render starvation concealment; separately retain missing REAL duration |
| QUEUED_NOT_RENDERED | Admitted span has no corresponding unmuted consumed/render contribution within complete coverage; account for epoch reset/discard/mute |
| RENDERED_BUT_UNIDENTIFIED | REAL admission and consumed contribution are proven, while mic-component identification in final residual fails the unchanged NCC gate |

Admission and rendering are stages, not mutually exclusive counts. Preserve
packet fate plus frame-level REAL/PLC/render coverage so a partially skipped or
retimed packet is not assigned its full nominal 2.5 ms twice. Positive socket
slack alone does not prove a recoverable early reject: the output consumer may
already have submitted future audio. Read the actual horizon and queue position.

For sender-active regions, report missing REAL intervals, each duration,
longest and total; PLC-covered duration; final residual similarity; native PCM
zero intervals ≥1 ms; and the established ≥60 ms missing/unknown component
events. Keep the V2 activity/noise criterion and ignore natural vocal pauses.
Retain clips and confidence. Strong nonzero PLC may remain unidentifiable;
do not count it as restored speech. Late-cut counters count affected packets,
not audible dropouts. Keep the independent human listening observation apart
from waveform evidence.

The old take's packet history cannot be recreated by a new recording at the
same song coordinate. [OLD_SIGNAL_ANALYSIS.md](OLD_SIGNAL_ANALYSIS.md) and
`old-host-to-laptop-analysis-comparison.json` document a proven lag-grid cause
for two historical failed cells; 39 s and the old packet provenance remain
unresolved where no trace existed. Fresh packet classifications describe the
fresh take. Never attach later receive/render events to historical WAVs.

The offline classifier is [classify_packet_trace.py](classify_packet_trace.py):

```text
python/.venv/Scripts/python.exe artifacts/room-e2e/2026-10-19-direct-packet-trace/classify_packet_trace.py TAKE_PACKET_CONFIG.json OUTPUT_PREFIX
```

Its config requires `senderTracePrefix`, `receiverTracePrefix`, `senderTimeline`,
`receiverTimeline`, `songStartRoomFrame`, actual `selectedDeadlineMs`, native
`receiverDeviceRate` and `fileStartsAtSongSeconds` from that take's backing
alignment. Set the actual `senderParticipantKey` if it cannot be inferred from
one sender identity. `segmentedResult` imports every required voiced cell and
new unidentified event from the approved 1 s result. Add explicit `cells` with
`id`, `songSeconds`, `durationMs` and, where known, `identified`/exact
`receiverFileSeconds` for the eleven requested coordinate checks. Relative
input paths resolve against that config's directory. It writes `.json` and
`.packets.csv`, with integrity hashes and explicit evidence errors; incomplete
coverage exits nonzero. Source keys, hashes and clocks remain integers or
rational values until presentation.

Classification totals do not automatically mean audible lost voice. The
classifier's missing-REAL duration includes source silence until intersected
with the independent real-mic activity mask. An unidentified whole-cell flag
does not establish that each individual rendered packet in that cell failed a
separate waveform-identification test. Preserve the original waveform and
per-cell evidence with the packet report.

## Proof files and close-out

Current dedicated evidence already present in this directory:

- [native-red.txt](native-red.txt): trace/span RED before implementation.
- [native-first-green-gain-red.txt](native-first-green-gain-red.txt): core trace,
  exact span and provenance tests GREEN; includes a separately discovered gain
  metric RED, resolved by [gain-green.txt](gain-green.txt).
- [ipc-red.txt](ipc-red.txt) → [ipc-green.txt](ipc-green.txt): trace-only control
  cannot fall through to audio replacement/delay handling.
- [trace-token-red.txt](trace-token-red.txt) →
  [trace-token-green.txt](trace-token-green.txt): delayed metadata from the old
  take cannot cross an immediate rearm; endpoint identities are cached.
- [pipeline-red.txt](pipeline-red.txt) → [pipeline-green.txt](pipeline-green.txt)
  and [udp-join-green.txt](udp-join-green.txt): actual admission/render and real
  UDP sender/arrival/admission/render joins with unchanged PCM.
- [capture-full-trace-red.txt](capture-full-trace-red.txt) →
  [capture-full-trace-green.txt](capture-full-trace-green.txt): helper lifecycle
  on success and failure, including no legacy diagnostic-input rearm.
- [analyzer-fractional-grid-red.txt](analyzer-fractional-grid-red.txt) →
  [analyzer-fractional-grid-green.txt](analyzer-fractional-grid-green.txt), plus
  [analyzer-full-suite-green.txt](analyzer-full-suite-green.txt): offline lag-grid
  correction with unchanged confidence and ambiguity rules.
- [packet-classifier-red.txt](packet-classifier-red.txt) →
  [packet-classifier-green.txt](packet-classifier-green.txt): integer/rational
  packet identity, coverage and queue/render classification regressions.
- [PROVENANCE_AUDIT.md](PROVENANCE_AUDIT.md): source ownership and existing
  PLC/starvation/history regression coverage.
- [rejected-history-green.txt](rejected-history-green.txt): explicit receive
  history rejection regression for both fully late and queue-full real PCM.

The completed [native-full-release.txt](native-full-release.txt) passes all 473
cases present in that full run. The additional history regression above then
passed separately, bringing the registered total to 474. The four auxiliary
CTest checks passed in [ctest-release.txt](ctest-release.txt); that initial log
also retains its failed main-suite attempt and must not be relabelled as a
5/5 CTest pass. The later complete native run is the replacement native proof.
The measured 4096-block trace/control comparison in the full native log reports
1861 ns versus 862 ns mean per 120-frame block (2.5 ms block budget), exact PCM
identity and zero RT violations. This is the recorded test measurement, not a
claim about worst-case physical callback duration.

These tests do not establish physical PASS. Add the completed full native
suite/build log, exact commits/native hashes, both raw trace sets, all source/
master/backing/residual WAVs and CSVs, configs, UI evidence, per-packet/cell/
unknown reports, clips and integrity manifest for the actual run.

If a new audio runtime bug is proven, first create its deterministic RED replay,
then make the smallest correction and prove GREEN, zero added latency/drift,
bounded queue and no stale PCM replay. Re-run this full host → laptop gate and
a short laptop → host physical regression. Otherwise preserve audio behavior
and do not change deadline to compensate for an analysis failure.

After recording, restore normal controls through UI, leave/close both owned
applications, handle recording-save dialogs, and verify no Electron/backend/
AudioService belonging to those instances remains. Stop only the owned tunnel
or launch tasks. Final acceptance requires complete confidence/packet/WAV
coverage and the finished full AudioService suite; otherwise report FAIL with
one demonstrated cause and preserve the unresolved evidence explicitly.
