Karaoke v4: external audio and independent references

1. Primary independent benchmark (frozen before predictions)
Source: GTSinger, authors Yu Zhang et al., NeurIPS 2024.
Dataset: https://huggingface.co/datasets/GTSinger/GTSinger
Paper: https://arxiv.org/html/2409.13832v3 (sections3.3 andA.2).
Code: https://github.com/AaronZ345/GTSinger
Pinned dataset revision:4426c862beed558b7e1cb8a4dce7e8c0c83bb208.

frozen-reference.json contains4 Russian clips,24 word occurrences,32.448979s,
11 distinct word strings. It was written before this project's v3/v4 model
outputs were inspected. SHA25666d013885747828a0dfc90d6bfb53fd1117fdb7c1e080640dde0dce7be5e7a97.
Selection: first2 indexed clips in the Control and Breathy groups of the
first Russian Breathy song, Аня Облонская. No selected clip was replaced
because a model did poorly or well.

Independent annotation provenance: authors used MFA for an initial alignment,
then music/language annotators corrected boundaries using listening and
spectrograms; annotations are externally published and predate this project.
The agent did not pretend to have listened or create its own manual reference.
JSON word boundaries were checked against the corresponding TextGrid word tier
and match exactly. No reference timings are to be supplied to the inference
pipeline: text only, then score against the withheld reference times.

Annotation quality is not assumed perfect. Seven word instances have suspect
phone labels: uniform divisions of вронская, бедная, control блестящей, and
long /j/ in гордые. These are excluded from quantitative phoneme comparisons.
Word metrics retain all24 instances with the caveat that the two initial в
have start=0 at a cropped boundary. See reference-quality-audit.json.
The /n:/ of анна corresponds to the two-letter нн group, not to two manually
labelled consonants. Do not invent an acoustic boundary between these glyphs.
Published note labels represent realistic score annotations; they are not
an independent millisecond-precise F0 ground truth.

2. Additional consonant-ending benchmark (also frozen before predictions)
Root requested an additional diagnostic set because the initial words mostly
end in vowels. The original24 remain the primary holdout.
Rule: inspect later Control_Group clip JSONs in ascending numeric order and
select the first2 with at least2 words ending in a pronounced consonant.
0002 did not qualify;0003 and0004 did. Only external metadata was inspected.
frozen-additional-reference.json:10 word occurrences,15.607s,
SHA25614fa21f2589a3088dd68c6ed8a1ecf363181e43f4c2fa985d8ee1ccdbb646d70.
Selection record:additional-selection-rule.json,additional-selected-candidates.json.

3. Exact recordings of the project's songs obtained independently online
SadSvit—Небо: https://sadsvit.bandcamp.com/track/--15
Official artist public stream,219.84725s decoded,mp3-128.
SHA256 of downloaded mp3:6a616f2b375ede9e75db442821d7d41a1a9b038ecdac58bd5627ab1bd4224a9f.
The project's vocal+instrumental fixture sums match this stream:
phrase93(offset84s):Pearson0.998648265,best shift0samples;
phrase129(offset116s):Pearson0.998749227,best shift0samples;
outro(offset181s):Pearson0.997600172,best shift0samples.
Evidence:sadsvit-source-comparison.json and compare_sadsvit_source.py.

Wildways—Километры:https://soundcloud.com/wildways/kilometry
Official artist public stream,204.126625s decoded,hls_aac_160k.
SHA256 of downloaded m4a:7c6eb9aeff5ed03e58c3630ff317f0e8f7351d5301823021ab5b3c6ee60abe9a.
The project's vocal+instrumental sums match this stream at a constant offset
+970samples at16kHz=+60.625ms:
clean_entry0.993737267,fast0.993405155,native_fast0.993403980,reply0.995783450.
The offset is the same across both tested regions57s and110s, not a time-warp.
Evidence:wildways-source-comparison.json and compare_wildways_source.py.
These matches establish the same recorded performances and exact relation to
the existing fixture timelines. They do not establish phonetic word truth.
The precise preprocessing behind uncertain_scores remains unidentified.

Downloads used the already-installed yt_dlp with --compat-options no-certifi
(system HTTPS CA instead of the venv's incomplete certifi bundle); certificate
validation was not disabled. Full source audio was not edited. A separate
mono16k WAV copy was decoded with ffmpeg for correlation/analysis. Original
project audio and timing are untouched.

4. Ukrainian acoustic inspection and limits
No independently hand-labelled Ukrainian singing corpus was found in bounded
primary-source searches. Official SadSvit audio is now available; lack of
audio itself is no longer the limitation for these fixtures.
plot_sadsvit_tails.py creates3way spectrograms/RMS(vocal, instrumental, official
mix), with no algorithm timestamps overlaid. Signal-only inspection shows
broad changes from strong formant structure to decay/instrument leakage near
86.2–86.4s,118.1–118.4s,and182.3–182.5s. These are approximate transition regions,
not listening-certified word ends, reference labels, or prescribed cutoffs.
Harmonic/RMS energy persists after them. These plots support investigation
but cannot alone distinguish all reverberation from soft continued singing.
Do not use these regions to report word error in milliseconds as if manually
annotated, or as constants in production.

5. Reproduction and distribution
Use fetch_gtsinger_reference.py --destination PATH with adjacent manifests.
All selected external dataset files are pinned to a commit and SHA256-checked.
The corpus is licensed CC BY-NC-SA4.0; saved license.txt has its complete terms
and attribution requirements. The external audio is validation material, not
part of the application. Keep downloaded GTSinger audio, commercial tracks,
and raw yt_dlp .info.json metadata out of the app archive. Include the fetch
scripts/manifests, independently published annotation provenance, derived
measurements, and this report. Public song links above provide listening
access; no paid download, login, or access control was bypassed.

Searches also found the official SadSvit YouTube channels:
https://www.youtube.com/watch?v=Jj9RSrfs4tY
https://www.youtube.com/watch?v=cPzhNzqt9LA
The Bandcamp version was chosen because it was a public artist stream with
an accessible rendition matching the fixture. A YouTube metadata attempt
failed due to the venv certificate bundle; no bypass attempt was made.

Additional phoneme-label audit (before predictions): additional-reference-quality-audit.json excludes замечаешь,течение,времени,понимаешь from strict phone accuracy claims. They contain short vowels adjacent to long /j/ or /ɲ/, or uniform divisions. In particular650ms/ɲ/ in времени is not certified evidence of a genuinely long nasal. The frozen external labels and word cohort are unchanged.

6. Requested raw-signal audit of two disagreement cases
independent-tail-audit.json/independent-tail-features.json and *-audit.png show that breathy аня has a direct-vowel-to-breath/gap transition near6.50–6.55s and separate onset near7.13s: extending this word to7.160s bridges distinct events. Conversely, control second анна already loses coherentvoicing near4.29–4.32s; its publishedend4.441s includes veryquiet residualenergy. A predicted4.31s should not be stretched to the annotation only to improve a score. These are waveform-based transition intervals, not agent-listened exact labels; external annotations remain frozen and unchanged.
