var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// project/karaoke_new_version-refactor-frontend-direct/frontend/src/features/karaoke/karaokeLyrics.ts
var karaokeLyrics_exports = {};
__export(karaokeLyrics_exports, {
  buildLines: () => buildLines,
  currentLineIndex: () => currentLineIndex,
  karaokePitchToleranceSemitones: () => karaokePitchToleranceSemitones,
  letterProgress: () => letterProgress,
  lyricSilenceSeconds: () => lyricSilenceSeconds,
  noteHitReached: () => noteHitReached,
  pitchAccuracy: () => pitchAccuracy,
  pitchHzToMidi: () => pitchHzToMidi,
  pitchMatchesTarget: () => pitchMatchesTarget,
  pitchMidiNearTarget: () => pitchMidiNearTarget,
  pitchRange: () => pitchRange,
  reliablePitchHz: () => reliablePitchHz,
  scorableNoteDuration: () => scorableNoteDuration,
  targetPitchAt: () => targetPitchAt,
  upcomingLinePhase: () => upcomingLinePhase
});
module.exports = __toCommonJS(karaokeLyrics_exports);
var maxWordsPerLine = 8;
var lyricSilenceSeconds = 3;
var writtenLineSizes = (lyrics, wordCount) => {
  const sizes = (lyrics ?? "").split(/\r?\n/).map((line) => line.split(/\s+/).filter(Boolean).length).filter((size) => size > 0);
  return sizes.length > 1 && sizes.reduce((sum, size) => sum + size, 0) === wordCount ? sizes : null;
};
var groupWords = (words, sizes, pauseSeconds) => {
  let writtenEnd = sizes?.[0] ?? words.length;
  let writtenLine = 0;
  const lines = [];
  for (const [index, word] of words.entries()) {
    const writtenBreak = index === writtenEnd;
    if (writtenBreak) writtenEnd += sizes?.[++writtenLine] ?? 0;
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const gap = previous ? word.start - previous.end + 1e-6 : 0;
    const startsNewLine = !current || !previous || writtenBreak || current.length >= maxWordsPerLine || gap >= pauseSeconds || /[,;:.!?…]$/.test(previous.text) && gap >= pauseSeconds / 4;
    if (startsNewLine) lines.push([word]);
    else current.push(word);
  }
  return lines;
};
var buildLines = (words, lyrics, bpm) => groupWords(
  words,
  writtenLineSizes(lyrics, words.length),
  Math.max(0.3, Math.min(0.9, 60 / (bpm && Number.isFinite(bpm) && bpm > 0 ? bpm : 120)))
).map((group) => ({
  words: group,
  start: group[0]?.start ?? 0,
  end: group.at(-1)?.end ?? 0
}));
var currentLineIndex = (lines, position) => {
  if (lines.length === 0) return -1;
  const active = lines.findIndex(
    (line) => position >= line.start && position <= line.end
  );
  if (active >= 0) return active;
  const upcoming = lines.findIndex((line) => line.start > position);
  const previous = lines[upcoming - 1];
  const next = lines[upcoming];
  if (previous && next && position - previous.end < lyricSilenceSeconds && next.start - position > lyricSilenceSeconds) return upcoming - 1;
  return upcoming >= 0 ? upcoming : lines.length - 1;
};
var upcomingLinePhase = (lines, lineIndex, position) => {
  const line = lines[lineIndex];
  if (!line) return { kind: "text" };
  const previousEnd = lines[lineIndex - 1]?.end ?? 0;
  const longGap = line.start - previousEnd > lyricSilenceSeconds;
  const secondsUntilStart = line.start - position;
  const kind = [
    [
      "empty",
      position >= line.end + lyricSilenceSeconds || longGap && secondsUntilStart > lyricSilenceSeconds
    ],
    ["countdown", longGap && secondsUntilStart > 0.65]
  ].find(([, active]) => active)?.[0] ?? "text";
  const followedBySilence = (lines[lineIndex + 1]?.start ?? Infinity) - line.end > lyricSilenceSeconds;
  const fadeOut = followedBySilence ? (line.end + lyricSilenceSeconds - position) / 0.7 : 1;
  const fadeIn = kind === "countdown" ? (lyricSilenceSeconds - secondsUntilStart) / 0.45 : 1;
  const opacity = Math.max(0, Math.min(1, fadeOut, fadeIn));
  return {
    kind,
    ...kind !== "empty" && opacity < 1 ? { opacity } : {},
    ...kind === "countdown" ? { countdown: Math.ceil(secondsUntilStart) } : {}
  };
};
var vowels = /[aeiouyаеёиоуыэюяіїє]/i;
var punctuation = /[.,!?;:'"()\-–—…«»„“”]/;
var consonantSeconds = 0.07;
var consonantShareLimit = 0.4;
var characterSeconds = (text, duration) => {
  const letters = [...text].filter(
    (character) => !punctuation.test(character)
  );
  if (letters.length === 0) return [];
  const vowelCount = letters.filter(
    (character) => vowels.test(character)
  ).length;
  if (vowelCount === 0 || vowelCount === letters.length) {
    const each = duration / letters.length;
    return letters.map(() => each);
  }
  const consonantCount = letters.length - vowelCount;
  const consonant = Math.min(
    consonantSeconds,
    duration * consonantShareLimit / consonantCount
  );
  const vowel = (duration - consonant * consonantCount) / vowelCount;
  return letters.map((character) => vowels.test(character) ? vowel : consonant);
};
var letterProgress = (word, position) => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  const duration = Math.max(word.end - word.start, 1e-3);
  if (word.letters && word.letters.length > 0)
    return timedLetterProgress(
      word.letters,
      word.text,
      (position - word.start) / duration
    );
  const seconds = characterSeconds(word.text, duration);
  let remaining = position - word.start;
  for (const [index, seconds_] of seconds.entries()) {
    if (remaining < seconds_)
      return (index + remaining / seconds_) / seconds.length;
    remaining -= seconds_;
  }
  return 1;
};
var timedLetterProgress = (starts, text, fraction) => {
  const realIndices = [...text].map((character, index) => punctuation.test(character) ? -1 : index).filter((index) => index >= 0);
  const count = realIndices.length;
  if (count === 0) return 1;
  let position = 0;
  for (let candidate = count - 1; candidate >= 0; candidate--) {
    const start2 = starts[realIndices[candidate] ?? -1];
    if (start2 !== void 0 && start2 <= fraction) {
      position = candidate;
      break;
    }
  }
  const start = starts[realIndices[position] ?? -1] ?? 0;
  const nextIndex = position + 1 < count ? realIndices[position + 1] : void 0;
  const next = nextIndex !== void 0 ? starts[nextIndex] ?? 1 : 1;
  const span = Math.max(next - start, 1e-6);
  return Math.min(
    1,
    (position + Math.min(1, Math.max(0, (fraction - start) / span))) / count
  );
};
var rangeSemitones = {
  auto: 0,
  octave: 12,
  twoOctaves: 24
};
var pitchRange = (notes, range) => {
  if (notes.length === 0) return { min: 48, max: 72 };
  const pitches = notes.map((note) => note.pitch);
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);
  const span = rangeSemitones[range];
  if (span === 0) return { min: low - 2, max: high + 2 };
  const centre = (low + high) / 2;
  return {
    min: Math.round(centre - span / 2),
    max: Math.round(centre + span / 2)
  };
};
var pitchHzToMidi = (pitchHz) => pitchHz !== void 0 && Number.isFinite(pitchHz) && pitchHz > 0 ? 69 + 12 * Math.log2(pitchHz / 440) : void 0;
var targetPitchAt = (note, position) => {
  const points = note.contour;
  if (!points?.length) return note.pitch;
  const fraction = (position - note.start) / (note.end - note.start);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + high >>> 1;
    if (points[middle][0] < fraction) low = middle + 1;
    else high = middle;
  }
  const left = points[Math.max(0, low - 1)];
  const right = points[Math.min(low, points.length - 1)];
  const nearest = Math.abs(left[0] - fraction) <= Math.abs(right[0] - fraction) ? left : right;
  if ((nearest[2] ?? 1) < 0.5) return void 0;
  const weight = right[0] > left[0] ? Math.max(0, Math.min(1, (fraction - left[0]) / (right[0] - left[0]))) : 0;
  return note.pitch + left[1] + (right[1] - left[1]) * weight;
};
var scorableNoteDuration = (note) => {
  const points = note.contour;
  const fraction = points?.length ? points.reduce((sum, point, index) => {
    if ((point[2] ?? 1) < 0.5) return sum;
    const previous = points[index - 1];
    const next = points[index + 1];
    const start = previous ? (previous[0] + point[0]) / 2 : 0;
    const end = next ? (next[0] + point[0]) / 2 : 1;
    return sum + end - start;
  }, 0) : 1;
  return Math.max(0, note.end - note.start) * fraction;
};
var karaokePitchToleranceSemitones = 1;
var reliablePitchHz = (pitchHz, confidence = 1) => confidence >= 0.8 ? pitchHz : void 0;
var pitchMidiNearTarget = (pitchHz, targetMidi) => {
  const midi = pitchHzToMidi(pitchHz);
  if (midi === void 0) return void 0;
  return targetMidi === void 0 ? midi : midi + 12 * Math.round((targetMidi - midi) / 12);
};
var pitchAccuracy = (pitchHz, targetMidi) => {
  const midi = pitchMidiNearTarget(pitchHz, targetMidi);
  if (midi === void 0 || targetMidi === void 0) return 0;
  return Math.max(
    0,
    1 - Math.abs(midi - targetMidi) / karaokePitchToleranceSemitones
  );
};
var pitchMatchesTarget = (pitchHz, targetMidi) => {
  const midi = pitchMidiNearTarget(pitchHz, targetMidi);
  return midi !== void 0 && Math.abs(midi - targetMidi) <= karaokePitchToleranceSemitones;
};
var noteHitReached = (matchedSeconds, durationSeconds) => durationSeconds > 0 && matchedSeconds / durationSeconds + Number.EPSILON >= 0.5;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildLines,
  currentLineIndex,
  karaokePitchToleranceSemitones,
  letterProgress,
  lyricSilenceSeconds,
  noteHitReached,
  pitchAccuracy,
  pitchHzToMidi,
  pitchMatchesTarget,
  pitchMidiNearTarget,
  pitchRange,
  reliablePitchHz,
  scorableNoteDuration,
  targetPitchAt,
  upcomingLinePhase
});
