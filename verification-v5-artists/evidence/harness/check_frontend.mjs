/** Data-level checks using the unchanged production TypeScript, not a browser/font test. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['repo', 'inputs', 'output']) assert(options[key], `Missing --${key}`);
assert(Boolean(options['documents-dir']) !== Boolean(options['payload-dir']), 'Choose documents-dir or payload-dir');
const root = path.resolve(options.repo);
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const { transformSync } = require('esbuild');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = {};
const neverCalled = () => { throw new Error('No desktop/network call allowed in this check'); };

function loadTypescript(relative) {
  const source = path.join(root, relative);
  const text = fs.readFileSync(source, 'utf8');
  sources[relative] = sha(source);
  const transformed = transformSync(text, { loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: source });
  const module = { exports: {} };
  vm.runInNewContext(transformed.code, {
    module, exports: module.exports,
    require(specifier) {
      if (specifier === '../../services/desktopBridge') return { bridgedHttp: neverCalled };
      if (specifier === '../../services/backendEvents') return { libraryChanged: neverCalled };
      throw new Error(`Unapproved runtime import: ${specifier}`);
    },
  }, { filename: source });
  return module.exports;
}

const { createEditorApi } = loadTypescript('frontend/src/pages/editor/editorApi.ts');
const { letterProgress, buildLines, currentLineIndex, upcomingLinePhase } = loadTypescript('frontend/src/features/karaoke/karaokeLyrics.ts');
const silent = /[\p{M}\s.,!?;:'’ʼ‘"()\-–—…«»„“”ьъ]/iu;
const cases = JSON.parse(fs.readFileSync(options.inputs, 'utf8')).cases
  .filter((c) => !options.case || c.case === options.case);
assert(cases.length > 0, 'No selected cases');
const results = [];

function geometry(text) {
  const widths = [...text].map((c) => .4 + c.codePointAt(0) % 13 / 7);
  const total = widths.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return widths.map((width) => { const start = cursor; cursor += width / total; return [start, cursor]; });
}

for (const c of cases) {
  const source = options['documents-dir']
    ? path.join(options['documents-dir'], c.case, 'final', 'lyricsSync.json')
    : path.join(options['payload-dir'], c.case, 'payload.json');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const document = options['documents-dir'] ? raw : {
    title: c.case, artist: 'data-level check', duration: c.duration, bpm: null, key: null,
    lyrics: c.lyrics, words: raw.words.map((w) => ({ ...w, notes: [] })),
  };
  let saved;
  const api = createEditorApi(async (request) => {
    if (request.method === 'GET') return { songId: c.case, revision: 1, document };
    if (request.method === 'PUT') { saved = request.body.document; return { revision: 2 }; }
    throw new Error('Unexpected method');
  });
  const editor = await api.load(c.case);
  await api.save({ id: c.case, title: document.title, artist: document.artist, durationSeconds: c.duration }, editor, 1);
  const failures = [], jumps = [], roundTrips = [];
  const lines = buildLines(editor.words, editor.lyrics, editor.bpm);
  let samplesChecked = 0;
  for (const [index, word] of editor.words.entries()) {
    const original = document.words[index];
    const restored = saved.words[index];
    assert.equal(word.start, original.start);
    assert.equal(word.end, original.end);
    assert.equal(restored.start, original.start);
    assert.equal(restored.end, original.end);
    assert.equal(word.text, original.text);
    const absoluteRoundTripError = Math.max(0, ...(original.letters ?? []).map((value, j) => Math.abs(value - (restored.letters?.[j] ?? NaN))));
    if (!Number.isFinite(absoluteRoundTripError) || absoluteRoundTripError > 1e-12) failures.push({ index, word: word.text, type: 'letter_fraction_roundtrip', absoluteRoundTripError });
    for (const [j, note] of original.notes.entries()) {
      const restoredNote = restored.notes[j];
      if (!restoredNote || restoredNote.note !== note.note || restoredNote.start !== note.start || restoredNote.end !== note.end
          || JSON.stringify(restoredNote.contour ?? []) !== JSON.stringify(note.contour ?? [])) failures.push({ index, noteIndex: j, type: 'note_roundtrip_changed' });
    }
    roundTrips.push({ wordIndex: index, word: word.text, absoluteLetterRoundTripErrorSeconds: absoluteRoundTripError });
    const duration = word.end - word.start;
    const epsilon = Math.min(1e-7, duration / 100000);
    const moments = new Set([word.start - epsilon, word.start, word.end, word.end + epsilon]);
    for (let step = 0; step <= 1000; step++) moments.add(word.start + duration * step / 1000);
    for (const t of original.letters ?? []) for (const shift of [-epsilon, 0, epsilon]) moments.add(t + shift);
    const ordered = [...moments].sort((a, b) => a - b);
    const spoken = [...word.text].map((character, j) => ({ character, j })).filter(({ character }) => !silent.test(character));
    for (const mode of ['no-geometry', 'deterministic-nonuniform-widths']) {
      const widths = mode === 'no-geometry' ? undefined : geometry(word.text);
      let previous = -Infinity;
      for (const moment of ordered) {
        const value = letterProgress(word, moment, widths);
        samplesChecked++;
        if (!Number.isFinite(value) || value < -1e-12 || value > 1 + 1e-12) failures.push({ index, word: word.text, type: 'progress_out_of_range', moment, value, mode });
        if (value + 1e-12 < previous) failures.push({ index, word: word.text, type: 'non_monotone_progress', moment, previous, value, mode });
        previous = value;
      }
      if (letterProgress(word, word.start, widths) !== 0 || letterProgress(word, word.end, widths) !== 1) failures.push({ index, word: word.text, type: 'wrong_progress_endpoint', mode });
      if (spoken.length && letterProgress(word, word.end - epsilon, widths) >= 1) failures.push({ index, word: word.text, type: 'complete_before_saved_end', mode });
      for (let j = 0; j + 1 < spoken.length; j++) {
        const a = spoken[j], b = spoken[j + 1];
        const first = original.letters?.[a.j], second = original.letters?.[b.j];
        if (first === undefined || second === undefined || Math.abs(first - second) > 1e-12) continue;
        const before = letterProgress(word, first - epsilon, widths);
        const after = letterProgress(word, second + epsilon, widths);
        jumps.push({ wordIndex: index, word: word.text, indices: [a.j, b.j], characters: a.character + b.character,
          time: first, progressBefore: before, progressAfter: after, jumpFraction: after - before, mode,
          finding: 'Coincident non-silent saved starts: instantaneous progress needs acoustic review; no frontend smoothing added.' });
      }
    }
    const lineIndex = lines.findIndex((line) => line.words.some((w) => w.id === word.id));
    for (const position of [word.start + epsilon, (word.start + word.end) / 2, word.end - epsilon]) {
      const active = currentLineIndex(lines, position);
      if (active !== lineIndex) failures.push({ index, word: word.text, type: 'wrong_active_line_inside_word', position, expected: lineIndex, actual: active });
      const phase = upcomingLinePhase(lines, active, position);
      if (phase.kind !== 'text') failures.push({ index, word: word.text, type: 'word_hidden_during_saved_interval', position, phase });
    }
  }
  for (const [index, line] of lines.entries()) {
    const position = line.end - Math.min(1e-7, (line.end - line.start) / 100000);
    if (currentLineIndex(lines, position) !== index) failures.push({ lineIndex: index, type: 'line_not_retained_until_end', position });
  }
  results.push({ case: c.case, source, sourceSha256: sha(source), words: editor.words.length, notes: editor.notes.length,
    lines: lines.map((line) => ({ start: line.start, end: line.end, words: line.words.map((w) => w.text) })),
    samplesChecked, failures, coincidentSoundingLetterReviews: jumps, roundTrips,
    finalLyricsDocument: Boolean(options['documents-dir']) });
}
for (const [relative, checksum] of Object.entries(sources)) assert.equal(sha(path.join(root, relative)), checksum);
const report = {
  scope: 'Actual unchanged editorApi.ts + karaokeLyrics.ts transpiled in memory with installed esbuild. Only desktopBridge/backendEvents imports stubbed; actual createEditorApi load/save conversion exercised. Deterministic nonuniform widths are test geometry, not measured font geometry. No Electron/browser/audio-listening verification.',
  mode: options['documents-dir'] ? 'final-production-lyricsSync-with-notes' : 'alignment-payload-with-empty-notes; final document construction not exercised',
  inputSha256: sha(options.inputs), sourceHashes: sources, sourceUnchanged: true,
  totalWords: results.reduce((sum, r) => sum + r.words, 0),
  totalNotes: results.reduce((sum, r) => sum + r.notes, 0),
  totalFailures: results.reduce((sum, r) => sum + r.failures.length, 0),
  totalCoincidentSoundingLetterReviews: results.reduce((sum, r) => sum + r.coincidentSoundingLetterReviews.length, 0),
  cases: results,
};
fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ words: report.totalWords, notes: report.totalNotes, failures: report.totalFailures,
  coincidentSoundingLetterReviews: report.totalCoincidentSoundingLetterReviews, mode: report.mode }));
