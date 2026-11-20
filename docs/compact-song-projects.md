# Compact generated karaoke projects

Date: 2026-11-20. Baseline: `3ab803df116ddb17e324c0842f96e4f70d4e09f8` (1.1.47).

## Result and storage policy

The complete fresh project for the supplied 293.5-second Lumen track occupies **39,566,195 bytes
(39.566 MB, 37.733 MiB)**. This includes the unchanged original, both playback stems, lossless
melody, both lyric documents, manifests and waveform data.

Generated instrumental and reference-vocal stems are now stored as **320 kb/s MP3**. This is
perceptual, lossy compression. The original imported media is retained byte-for-byte. Melody
remains FLAC. Recording storage is handled separately in
[compact-recordings.md](compact-recordings.md), following the user's additional request.

Initial separation, recognition, alignment and note extraction still operate before publication.
The compact encoder preserves decoded frame count, sample rate and channel count. It does not
downsample or downmix the normal 44.1 kHz stereo pipeline. Unusual existing PCM rates/layouts use
the lossless path rather than silently changing those properties.

| Artifact | Bytes |
| --- | ---: |
| Original MP3 | 11,805,787 |
| Instrumental MP3, 320 kb/s | 11,741,561 |
| Reference-vocal MP3, 320 kb/s | 11,741,561 |
| Melody FLAC | 2,663,398 |
| Both lyrics documents | 1,497,696 |
| Manifests, source references and waveform cache | 116,192 |
| **Whole song folder** | **39,566,195** |

The user-reported Windows folder was 143,287,732 bytes. That exact folder was not available here.
The available real separation and lyrics belong to the byte-identical uploaded source; publishing
those inputs with the baseline code creates a 109,439,594-byte project. The measured comparison is
therefore **104.370 MiB to 37.733 MiB**, not a direct inventory of the user's 136 MiB folder.

Source SHA256: `6df69c930aeeaa90d54385c28e605844f21896d54fd8c15ec666e808a9c06299`.

## Processing time

The benchmark invokes the actual `ProjectPublisher.publish_generated()` through a real application
container. It includes audio encoding, staging, waveform generation, checksums, validation,
manifest creation and database publication. Source import, container startup and neural inference
are outside the timed section. Both implementations use the same filesystem and the same full
duration PCM/lyrics inputs; the six runs alternate baseline and candidate order.

| Pair | Baseline publication | Compact publication |
| --- | ---: | ---: |
| 1 | 9.379 s | 8.512 s |
| 2 | 8.427 s | 8.412 s |
| 3 | 8.846 s | 8.164 s |
| **Median** | **8.846 s** | **8.412 s** |

The changed stage measured **4.91% faster** and was no slower in any of the three paired runs.
This is a local measurement, not a whole-pipeline timing or a guarantee for every machine.

Two bounded encoders run concurrently. Sequential MP3 conversion was measured and rejected
because it was slower than the old FLAC publication. Only the instrumental waveform sidecar is
generated for the compact stems. Existing MP3 input is identified by its actual decoded format and
reused without another lossy encode, including remote publication and melody-only regeneration.

## Timing, key and tempo

MP3 encoder delay and padding must not become a karaoke offset. Local MP3 files use a bundled,
commit- and SHA256-pinned `dr_mp3` decoder instead of relying on platform-dependent MP3 seeking.
It exposes the gapless PCM timeline and uses a bounded 512-entry seek index. No full decoded song
cache is created in RAM or on disk. Network streams keep their existing platform decoder.

Both final stems have **12,942,468 stereo frames at 44,100 Hz**. For each complete final file,
100 random/boundary/EOF seeks were compared with sequential decoding: maximum sample difference
was **zero**. Opening and indexing the final files measured 7.53 ms and 4.21 ms in that probe.

The repository's actual `RateTransposeProcessor` rendered both complete stems at every combination
of 0.5x, 1x and 1.5x speed and -12, -6, 0, +6 and +12 semitones. In all **30 comparisons**, the
compact and baseline outputs had exactly the same frame count, and neither clipped. The final
production MP3s decode bit-for-bit identically to the candidates used for these measurements.

| Metric across all settings | Instrumental | Reference vocal |
| --- | ---: | ---: |
| Minimum envelope correlation | 0.9999886 | 0.9999987 |
| Maximum relative spectral magnitude error | 0.923% | 0.494% |
| Maximum band-energy difference | 0.082 dB | 0.023 dB |
| SNR range | 36.12-37.04 dB | 38.00-39.83 dB |

The actual application pitch estimator compared 3,600 sampled vocal windows. Among the 1,312
windows confidently pitched in both versions, the largest pitch difference was **1.089 cents**,
with no differences of 50 cents or more. One sampled window crossed the selected 0.8 confidence
threshold. These measurements demonstrate small differences on this track; they do not establish
subjective inaudibility or identical analysis decisions for every future recording.

Both stored lyrics documents remain byte-identical: **371 words and 723 notes**. The melody's
decoded PCM is also bit-identical. Lyrics SHA256:
`e688c7e564bf3969ca4e2bb9677ead9af8139a73b65a2e081cc08f3f2d86d8e1`.

## Reprocessing, remote processing and history

- Melody/lyrics-only regeneration reuses stems whose previous manifest already records playback
  headroom. Small MP3 reconstruction overshoots do not trigger another attenuation/encoding pass.
- Legacy unprepared compressed audio that needs attenuation is written to a temporary WAV first.
- A changed extension removes the superseded audio entry from the **new staging revision**. The
  historical revision is not modified. Unchanged immutable stems stay shared by hard link where
  supported instead of being copied again.
- Encoding and sidecars live in disposable project-drive storage. An encoding or verification
  failure does not replace a previous ready revision or the original source.
- New worker requests negotiate `compactProjectAudio`; responses name actual audio files. New
  workers copy MP3/FLAC bytes for negotiated clients. Older clients receive real FLAC, and newer
  clients can still read the older fixed-FLAC response layout.
- The existing instrumental waveform cache follows the encoded MP3 path and hashes its final
  bytes. Package manifests continue to identify artifacts by logical name and actual path.

The 37.733 MiB result applies to a **fresh import followed by processing**. Existing historical FLAC
revisions, user recordings and optional videos are retained. Updating the application does not
automatically transcode or delete all historical song data, and longer songs can exceed this size.

## Verification scope

Regression tests cover atomic encode failure, truncated output, cancellation, source preservation,
real-format detection, exact sample count, stereo, waveform hashes, lossless fallback, concurrent
encoding, old-revision preservation, remote compatibility, and actual melody/lyrics regeneration.
Native tests add independent FFmpeg PCM anchors, frame-exact seeking at 44.1/48 kHz, Unicode paths,
cancel/reopen, invalid/truncated inputs, and real `MediaSource` pitch/tempo processing after a seek.
Synthetic fixtures contain no user recording or song.

The local native run passed 532 of 534 harness cases, including all five new MP3 tests. Runtime
installation/license verification and unknown-test rejection passed. Two Unix control-socket tests
could not bind: a separate minimal AF_UNIX bind reproduces `EPERM` in this environment, including
with a 35-byte `/tmp` path. No socket checks were omitted or weakened. The exact commit's normal CI
provides the Windows/Linux build and test results.

Live Windows Electron playback, physical audio devices and the repository's two-window live-room
gate require the Windows application environment. They were not executed here; unit tests and
offline audio measurements do not substitute for those live gates.

Machine-readable size, timing, preservation and DSP measurements are recorded in
[`compact-song-projects-measurements.json`](compact-song-projects-measurements.json).
