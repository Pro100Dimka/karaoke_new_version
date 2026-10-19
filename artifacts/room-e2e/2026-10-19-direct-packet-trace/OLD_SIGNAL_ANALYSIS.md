# Frozen host → laptop signal investigation, 2026-10-19

This is a reanalysis of the old `final-host-to-laptop` take. It does not rewrite
the 2026-10-15/16 physical report or assign packet events from a later recording
to the historical recording. Runtime audio, deadlines, DSP and devices are unchanged.

## One proven analyzer defect

The historical `locate` searched NCC at integer 8 kHz sample positions. It fitted
a parabola to the winning peak's position but retained its integer-grid NCC, and
another peak inside the same 50 ms event group could have a higher fractional
maximum. Near the 3.4 kHz band edge, a 0.125 ms lag grid was too coarse.

The control resamples the **already filtered 8 kHz arrays** at a constant ratio;
it does not change the filter, duration, sample-clock ratio, window, source,
search span or NCC threshold. No independently shifted pieces are stitched.
This isolates lag-search resolution from the different digital filter response
that filtering directly at 48 kHz would produce.

| Same required 1 s cell | Historical 8 kHz NCC | Constant 6x interpolated NCC | Constant 12x diagnostic NCC |
|---|---:|---:|---:|
| 32.000000 s | .180440 | .246828 | .246829 |
| 39.000000 s | .121593 | .122765 | .124268 |
| 73.6079375 s | .179466 | .236338 | .237203 |

The corresponding corrected full-window helper gives .246828273 / .122766767 /
.236334164, with separated second peaks .077521 / .091987 / .078620. The first
and third old failures are explained by lag-grid resolution. **39 s remains a
failed cell.** The small table differences come from local resampling context
boundaries; the pass/fail conclusions do not depend on them.

The minimal analyzer correction interpolates the local vocal segment and local
search context 6x, then calculates the full locally normalized NCC and **all
competing peaks** on that grid. It converts positions back to caller samples.
The backing's existing 4 kHz method, polarity rule, DC removal, .2 gate, 50 ms
separated-peak rule, complete required windows and source activity masks remain.
There is no audio runtime change or waveform time stretching.

Dedicated deterministic tests were added before that correction. A band-limited
fractional-lag fixture produced NCC .188606 and failed the unchanged gate on the
old code; corrected NCC is .255201 at source 8000.5369 for the known 8000.5
sample occurrence. A repeated occurrence exposes the second peak too: corrected
main/second are .255201/.255201 and uniqueness correctly fails. Refining only
the main peak would have been unsafe. Both tests were RED, then GREEN. Full
analyzer suite: **31/31 PASS, 26.563 s** (29 existing plus 2 regressions).

## The old take still fails

The corrected old take passes 19/20 start cells, 20/20 middle cells and 14/14
end voiced cells. Overall lag and drift remain **null / unaccepted**, because
39 s is still below .2. No neighbouring cell substitutes for it.

All source/master/backing files are native 48 kHz; source is mono and the two
receiver taps have identical frame counts. The bad cells have no clipped master
samples. Left/right residual differences are only about 1.7–1.8e-5 RMS versus
remote RMS .014–.032, so changing receiver channel does not explain their NCC.
Filtered matches have positive polarity; a global polarity inversion does not
repair the failures. Raw unfiltered matches also do not provide a consistent
solution. The residual is direct subtraction of the simultaneous backing tap,
without studio-reference fitting or an independently estimated backing offset.

At 32 s, every active diagnostic 20 ms piece reaches .486–.999 NCC within a
constant ±5 ms local search (median .997), while the entire 1 s cell had low
coherence. At 39 s the same diagnostic has median .310; at 73.6079375 s .686.
These pieces describe phase/coherence structure; they never replace a mandatory
1 s gate or establish REAL packet provenance.

## Eight old UNKNOWN intervals

The original positive-only 20 ms / ±5 ms classifier was reproduced using its
exact fractional 1 s expected-reference origins; all original event frames stay
below .2. Wider constant searches produce the candidates below. They are
diagnostics, not accepted lag measurements or REAL/PLC classifications.

| Old song start / duration | Whole-event candidate absolute NCC | Candidate shift from packet-clock hint | Remaining limitation |
|---|---:|---:|---|
| 38.03867 s / 60 ms | .1847 | +83.76 ms | Still weak; selected peak negative |
| 38.91867 s / 80 ms | .1998 | −66.48 ms | Still weak; selected peak negative |
| 39.17867 s / 80 ms | .3525 | +29.94 ms | Periodic/retimed/PLC candidates not distinguished |
| 70.47867 s / 60 ms | .9378 | −24.96 ms | Strong displaced waveform, REAL versus PLC not known |
| 76.19867 s / 80 ms | .3012 | −20.72 ms | Periodic/retimed/PLC candidates not distinguished |
| 85.39867 s / 80 ms | .4987 | −20.79 ms | Periodic/retimed/PLC candidates not distinguished |
| 113.93867 s / 60 ms | .4899 | −104.19 ms | Old-waveform candidate cannot prove current source presence |
| 130.75867 s / 80 ms | .2890 | +21.53 ms | Periodic/retimed/PLC candidates not distinguished |

The corrected whole-song reanalysis reports seven UNKNOWN events: the 130.75867 s
event no longer triggers and 113.93867 / 60 ms becomes 113.91867 / 80 ms. That is
a consequence of the corrected 1 s correspondence supplied to the unchanged
20 ms component classifier. It does **not** prove that all original packets in
either old event were REAL, admitted or rendered. Historical trace coverage is
insufficient for those categories. Strong displaced periodic waveform can also
be concealment, or an old phoneme; nonzero PCM is not proof of restored speech.

## Reproduction and files

Run from the repository root with `python/.venv/Scripts/python.exe`:

```text
artifacts/room-e2e/2026-10-19-direct-packet-trace/diagnose_old_signal.py
```

The script reads the immutable historical analyzer from Git `da3b7176` in memory,
hashes the old full WAVs, records native clocks and all 11 specified intervals,
and writes `old-host-to-laptop-signal-diagnostics.json`. No application or audio
endpoint is contacted. Its short-window diagnostic rows deliberately remain
outside the acceptance gate.

The corrected approved-1s reanalysis uses the existing
`diagnose_real_mic_windows.py` with the original config and strict-result inputs
and writes to the new directory only. See
`old-host-to-laptop-corrected-segmented-result.json.gz` and the compact
`old-host-to-laptop-analysis-comparison.json` for exact old/new cells, original
UNKNOWN coordinates, corrected UNKNOWN coordinates and analyzer hashes.

The RED, focused GREEN and complete suite logs are
`analyzer-fractional-grid-red.txt`, `analyzer-fractional-grid-green.txt` and
`analyzer-full-suite-green.txt`. The original physical report and old analysis
results remain untouched.
