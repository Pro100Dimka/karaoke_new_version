# Compact saved recordings and AD Masters

Date: 2026-11-20. Builds on the compact-song branch without changing live capture or mastering DSP.

## Storage policy

Ready recordings now enter the existing background archive independently. An original no longer
needs a completed AD Master and successful analysis before it can shrink. A background startup
pass also considers existing registered Ready recordings. Unregistered captures, unfinished
recordings and failed preparation remain outside archival.

| File | Archive policy |
| --- | --- |
| Original listening mix with verified retained voice/backing | MP3 320 kb/s at the same decoded frame count, rate and channel layout |
| Original with no trustworthy separate sources | Sample-exact FLAC; the only remastering source is not made lossy |
| AD Master listening mix | MP3 320 kb/s after checking its decoded true peak against the existing -1 dBTP ceiling |
| MP3 candidate exceeding the peak limit | Verified lossless fallback, without changing gain or re-encoding repeatedly |
| Encoder/decoder pair changing decoded frame count | Verified lossless fallback, preserving the exact recording timeline |
| Complete dry microphone source | FLAC24 only when every decoded float32 bit remains identical and the file is smaller |
| Arbitrary float, incomplete dry capture, wet vocal and backing sources | Retained without quantization |

Unsupported MP3 sample rates, channel layouts and sample types use the existing lossless path.
In particular, six-channel recordings are not silently downmixed. Existing MP3 is reused without
another lossy encode. The retained-source check verifies an actual lossless subtype, complete
finite decoded audio, synchronized frames/rate/channels and unchanged source identity.

MP3 listening copies are perceptually compressed, not sample-exact. Waveform sidecars include
the delivered file size and checksum. A separate `.archive.json` records the actual encoded
file and peak/loudness measurement, or identifies the sample-exact fallback. Historical Master
render reports remain unchanged.

## Measured sizes

These are three different real recordings previously supplied for this project; they are not an
original/Master pair and are not measurements of the user's entire Windows recordings directory.
No microphone recordings or music were added to the repository.

| Real input | Before | Final audio file | Change |
| --- | ---: | ---: | ---: |
| 52.67 s standalone original, stereo 48 kHz PCM16 | 10,112,684 B WAV | 4,114,030 B FLAC | 59.3% smaller, sample-exact |
| 109.395 s AD Master, stereo 44.1 kHz PCM24 | 28,946,022 B WAV | 4,378,165 B MP3 | 84.9% smaller |
| 124.517 s dry microphone, six channels, FLOAT WAV | 131,788,844 B | 62,335,748 B FLAC | 52.7% smaller, decoded bits identical |

The Master's former FLAC archive was 22,292,865 bytes; its MP3 is 80.4% smaller than that archive.
Including waveform and archive-report sidecars, the standalone original occupies 4,138,500 bytes
and the Master 4,402,641 bytes. The Master remains at -1.15 dBTP and -11.11 LUFS after encoding.

The dry conversion preserved all 5,491,200 frames and all 32,947,200 float32 sample bit patterns;
an independent decoded-PCM SHA256 also matched. Its original WAV was retained during the
benchmark; guarded retirement is covered separately by the archival tests.

The recording list displays the listening file's size. Whole directories also contain retained
remastering sources, metadata and history, so this change does not promise a 30-40 MB cap for
every recording directory.

## Time and background behavior

Three alternating old/new conversions measured the actual archive helpers, including normal
verification, waveform generation, final decoded peak measurement and metadata writes.

| Sample | Previous archive median | New archive median |
| --- | ---: | ---: |
| Standalone original | 0.743 s | 0.715 s |
| AD Master | 1.109 s | 3.888 s |

The stricter Master archive adds 2.779 seconds of background work in this local measurement;
it is not an encoding speedup. Registration/preparation and Master publication only queue this
work. They do not wait for conversion. Encoding starts when processing jobs are idle, and path
publication/removal uses the same job-submission guard. This avoids an additional blocking encode
on the recording-ready or Master-completion path; it does not claim that background CPU/IO is free.

One dry-source archive call measured 0.819 s, including encoding, full decoded equality and sync.
Input copying and independent post-run comparisons were outside that interval.

### MP3 algorithm quality and direct capture

The chosen format is LAME CBR 320 kb/s. Bitrate and algorithm quality are different settings:
[FFmpeg's libmp3lame documentation](https://ffmpeg.org/ffmpeg-codecs.html#libmp3lame) maps
`compression_level=0` to the slowest/highest algorithm-quality mode, while
[LAME's own usage documentation](https://github.com/lameproject/lame/blob/master/USAGE)
identifies the default CBR algorithm setting as q3.

One directly relevant four-encode comparison kept bitrate, thread count and gapless metadata
constant. On the full Lumen instrumental, the default encoder took 3.568 s and q0 took 10.845 s;
on the separate real Master, 1.325 s and 3.996 s. File sizes were identical within each pair,
and all decoded layouts matched. These are single encode timings, not whole-job medians, and
do not establish a perceived quality improvement. The default algorithm setting is retained
with 320 kb/s to honor the user's processing-time requirement.

Native capture continues to preserve PCM sources for later analysis/remastering. Only finished
listening copies get one MP3 encode. Writing MP3 during live capture would not by itself improve
the final codec quality or reduce a finished 320 kb/s file further; it would introduce encoding
work and new recovery requirements on the capture path. This change does not add that dependency.

## Recovery and reprocessing

- Pending work survives restart. Completion fingerprints avoid repeatedly encoding unchanged
  lossless fallbacks on each startup.
- New file paths are committed before superseded main files are removed. If Windows still holds
  a file open, cleanup is deferred and retried without another lossy encoding pass.
- The dry WAV is removed only under the idle guard, after verifying both the original and FLAC
  file identities. Cancellation or failed verification keeps the source.
- Wet/backing companions and legacy `recording.original.wav` recovery sources are retained.
- AD Master recognizes both `.dry.wav` and `.dry.flac` and still applies the dry-voice processing
  path. Repeated mastering follows the original recording link, not the compressed Master.
- Recording IDs, names, gaps, playback adjustments, analysis history and source/Master links are
  retained. Recording playback continues to use its saved performed timing and key.
- Analysis reserves its input through hashing and job submission, so archival cannot remove the
  file or swap the meaning of the recorded checksum during admission. Mastering resolves its
  retained stems after job admission and refreshes a path retired during an earlier metadata read.

## Verification scope

Verification is limited to the changed recording codec/archive/source paths, their registration
and mastering consumers, and recording library transport. It covers exact format/timing,
delivered peaks, lossy-WAV rejection as a retained source, existing-MP3 preservation, cancellation,
database failure, startup recovery, deferred Windows cleanup and source identity checks.
The native recorder/DSP and frontend implementation are unchanged in this follow-up.

The focused results are 13 recording-codec cases, 14 archive/registration cases, 36 dry-source
and directly affected mastering-consumer cases, 3 real lifecycle/transport/admission cases, and
4 analysis-admission cases. All passed. Scoped formatting/lint, Windows-target type checking and
function-size checks also passed. No test thresholds or timeouts were relaxed.

No broad project suite or new general Windows CI run was launched for this follow-up, following
the user's request. Live Windows microphone/room checks were not performed. Machine-readable
measurements are in [compact-recordings-measurements.json](compact-recordings-measurements.json).
