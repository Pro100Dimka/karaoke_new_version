/** Sample unchanged production karaoke timing for an explicitly programmatic preview. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const usage = 'node sample_frontend.mjs --repo PROJECT --document lyricsSync.json --layout layout.json --output samples.json';
const options = {};
if (process.argv.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert(['--repo', '--document', '--layout', '--output'].includes(key), `Unknown option: ${key}\n${usage}`);
  assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value for ${key}`);
  assert(options[key.slice(2)] === undefined, `Duplicate option: ${key}`);
  options[key.slice(2)] = process.argv[i + 1];
}
for (const key of ['repo', 'document', 'layout', 'output']) assert(options[key], `Missing --${key}`);
const root = path.resolve(options.repo);
const documentPath = path.resolve(options.document);
const layoutPath = path.resolve(options.layout);
const outputPath = path.resolve(options.output);
assert(outputPath !== documentPath && outputPath !== layoutPath, 'Output must not overwrite an input');
assert(!outputPath.startsWith(root + path.sep), 'The preview sampler must not write into the product repository');
const sha = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const documentHash = sha(documentPath);
const layoutHash = sha(layoutPath);
const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const tolerance = 1e-12;

assert.equal(layout.schemaVersion, 1, 'Unsupported layout schemaVersion');
assert(finite(document.duration) && document.duration > 0, 'Document duration must be positive');
assert(Array.isArray(document.words), 'A complete lyricsSync document with words is required');
assert(finite(layout.clipStartSeconds) && layout.clipStartSeconds >= 0, 'Invalid clipStartSeconds');
assert(finite(layout.fps) && layout.fps > 0, 'Invalid fps');
assert(Number.isSafeInteger(layout.frameCount) && layout.frameCount > 0, 'Invalid frameCount');
const clipEndSecondsExclusive = layout.clipStartSeconds + layout.frameCount / layout.fps;
assert(clipEndSecondsExclusive <= document.duration + tolerance,
  `Video interval exceeds document duration: ${clipEndSecondsExclusive} > ${document.duration}`);
assert(Array.isArray(layout.words) && layout.words.length === document.words.length,
  'Layout must contain geometry for every document word');

const geometryByWord = new Map();
for (const row of layout.words) {
  assert(Number.isSafeInteger(row.wordIndex) && row.wordIndex >= 0 && row.wordIndex < document.words.length,
    'Layout wordIndex is out of range');
  assert(!geometryByWord.has(row.wordIndex), `Duplicate geometry: word ${row.wordIndex}`);
  const original = document.words[row.wordIndex];
  assert.equal(row.text, original.text, `Geometry text differs: word ${row.wordIndex}`);
  assert(Array.isArray(row.geometry) && row.geometry.length === [...original.text].length,
    `Geometry requires one pair per Unicode code point: word ${row.wordIndex}`);
  for (const bounds of row.geometry) {
    assert(Array.isArray(bounds) && bounds.length === 2 && bounds.every(finite) && bounds[0] <= bounds[1],
      `Invalid glyph geometry: word ${row.wordIndex}`);
  }
  // Keep the supplied physical glyph fractions exactly; no geometry clamping or redistribution.
  geometryByWord.set(row.wordIndex, row.geometry);
}

const require = createRequire(path.join(root, 'frontend', 'package.json'));
const { transformSync, version: esbuildVersion } = require('esbuild');
const sourceHashes = {};
const blocked = () => { throw new Error('Preview sampling permits no desktop, backend-event or network calls'); };

function loadTypescript(relative) {
  const filename = path.join(root, relative);
  sourceHashes[relative] = sha(filename);
  const transformed = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: filename,
  });
  const module = { exports: {} };
  vm.runInNewContext(transformed.code, {
    module, exports: module.exports,
    require(specifier) {
      if (specifier === '../../services/desktopBridge') return { bridgedHttp: blocked };
      if (specifier === '../../services/backendEvents') return { libraryChanged: blocked };
      throw new Error(`Unapproved runtime import: ${specifier}`);
    },
  }, { filename });
  return module.exports;
}

const { createEditorApi } = loadTypescript('frontend/src/pages/editor/editorApi.ts');
const { buildLines, currentLineIndex, upcomingLinePhase, letterProgress, lyricSilenceSeconds } =
  loadTypescript('frontend/src/features/karaoke/karaokeLyrics.ts');
sourceHashes['frontend/src/features/karaoke/KaraokeStage.tsx'] =
  sha(path.join(root, 'frontend/src/features/karaoke/KaraokeStage.tsx'));
const songId = 'programmatic-preview';
let roundTrippedDocument;
const api = createEditorApi(async (request) => {
  assert.equal(request.path, `/songs/${songId}/editor`);
  if (request.method === 'GET') return { songId, revision: 1, document };
  if (request.method === 'PUT') {
    roundTrippedDocument = request.body.document;
    return { revision: 2 };
  }
  throw new Error(`Unexpected editor operation: ${request.method}`);
});
const editor = await api.load(songId);
await api.save({ id: songId, title: document.title, artist: document.artist,
  durationSeconds: document.duration }, editor, 1);
for (const key of ['bpm', 'key', 'lyrics', 'vocalActivity', 'rhythm']) {
  assert.equal(JSON.stringify(roundTrippedDocument[key]), JSON.stringify(document[key]),
    `Roundtrip changed document ${key}`);
}
assert.equal(editor.words.length, document.words.length);
assert.equal(roundTrippedDocument.words.length, document.words.length);
let maximumLetterRoundTripErrorSeconds = 0;
for (const [index, word] of editor.words.entries()) {
  const original = document.words[index];
  const restored = roundTrippedDocument.words[index];
  assert(finite(original.start) && finite(original.end) && original.end >= original.start,
    `Invalid saved word interval: ${index}`);
  for (const key of ['text', 'start', 'end']) {
    assert.equal(word[key], original[key], `Loader changed ${key}: word ${index}`);
    assert.equal(restored[key], original[key], `Roundtrip changed ${key}: word ${index}`);
  }
  if (original.letters?.length) {
    assert.equal(restored.letters?.length, original.letters.length, `Loader discarded letter starts: word ${index}`);
    for (const [letterIndex, moment] of original.letters.entries()) {
      assert(finite(moment), `Nonfinite letter start: word ${index}`);
      const error = Math.abs(moment - restored.letters[letterIndex]);
      maximumLetterRoundTripErrorSeconds = Math.max(maximumLetterRoundTripErrorSeconds, error);
      assert(error <= tolerance, `Letter fractions do not round-trip: word ${index}, letter ${letterIndex}`);
    }
  }
  assert.equal(restored.notes.length, original.notes.length, `Roundtrip changed note count: word ${index}`);
  for (const [noteIndex, note] of original.notes.entries()) {
    const restoredNote = restored.notes[noteIndex];
    for (const key of ['note', 'start', 'end']) assert.equal(restoredNote[key], note[key], `Roundtrip changed note ${key}`);
    assert.equal(JSON.stringify(restoredNote.contour ?? []), JSON.stringify(note.contour ?? []), 'Note contour changed');
  }
}

const lines = buildLines(editor.words, editor.lyrics, editor.bpm);
const indices = new Map(editor.words.map((word, index) => [word.id, index]));
const lineRows = lines.map((line, lineIndex) => ({
  lineIndex, start: line.start, end: line.end, wordIndices: line.words.map((word) => indices.get(word.id)),
}));
const frames = [];
for (let frame = 0; frame < layout.frameCount; frame++) {
  const timeSeconds = layout.clipStartSeconds + frame / layout.fps;
  const activeLineIndex = currentLineIndex(lines, timeSeconds);
  const phase = upcomingLinePhase(lines, activeLineIndex, timeSeconds);
  // The same preview gate used by KaraokeStage: do not announce a distant line.
  const current = lines[activeLineIndex], next = lines[activeLineIndex + 1];
  const previewLineIndex = current && next && next.start - current.end <= lyricSilenceSeconds
    ? activeLineIndex + 1 : -1;
  const words = editor.words.map((word, wordIndex) => {
    const progress = letterProgress(word, timeSeconds, geometryByWord.get(wordIndex));
    assert(finite(progress), `Nonfinite production progress: frame ${frame}, word ${wordIndex}`);
    return { wordIndex, progress };
  });
  // Exact production outputs: no rounding, interpolation, temporal smoothing, offsets or lookahead.
  frames.push({ frame, timeSeconds, activeLineIndex, previewLineIndex, phase, words });
}

for (const [relative, checksum] of Object.entries(sourceHashes)) assert.equal(sha(path.join(root, relative)), checksum);
assert.equal(sha(documentPath), documentHash, 'Input document changed during sampling');
assert.equal(sha(layoutPath), layoutHash, 'Input layout changed during sampling');
const output = {
  schemaVersion: 1,
  scope: 'Programmatic video timing samples, not an application screen recording. Exact unchanged production editorApi/lyrics functions; caller-supplied measured font geometry. No audio engine or browser clock is simulated.',
  documentPath, documentSha256: documentHash, layoutPath, layoutSha256: layoutHash,
  samplerSha256: sha(new URL(import.meta.url)), nodeVersion: process.version, esbuildVersion,
  sourceHashes, sourceUnchanged: true, inputsUnchanged: true,
  video: { clipStartSeconds: layout.clipStartSeconds, fps: layout.fps,
    frameCount: layout.frameCount, clipEndSecondsExclusive },
  document: { title: document.title, artist: document.artist, duration: document.duration,
    bpm: editor.bpm ?? null, revisionUsedForReadOnlyLoader: 1 },
  checks: { maximumLetterRoundTripErrorSeconds, wordBoundsUnchanged: true,
    noteCountsBoundsPitchesAndContoursRoundTrip: true, intervalWithinDocumentDuration: true,
    musicLyricsActivityRhythmRoundTrip: true, allDocumentWordsIncluded: true },
  words: editor.words.map((word, wordIndex) => ({ wordIndex, text: word.text, start: word.start, end: word.end,
    lettersAbsolute: document.words[wordIndex].letters ?? null, letterFractions: word.letters ?? null,
    geometry: geometryByWord.get(wordIndex) })),
  lines: lineRows,
  frames,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output) + '\n');
console.log(JSON.stringify({ output: outputPath, frames: frames.length, words: editor.words.length,
  lines: lineRows.length, sourceHashes, maximumLetterRoundTripErrorSeconds }));
