/** Evaluate the actual frontend at frozen external word times; no UI/source edits. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['repo', 'reference', 'output']) assert(args[key], `Missing --${key}`);
assert(Boolean(args['documents-dir']) !== Boolean(args['prediction-dir']));
const repo = path.resolve(args.repo);
const require = createRequire(path.join(repo, 'frontend/package.json'));
const { transformSync } = require('esbuild');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = {};
function load(relative) {
  const file = path.join(repo, relative), module = { exports: {} };
  sourceHashes[relative] = sha(file);
  const { code } = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: file });
  vm.runInNewContext(code, { module, exports: module.exports, require(specifier) {
    const never = () => { throw new Error('Network/desktop side effects are forbidden'); };
    if (specifier === '../../services/desktopBridge') return { bridgedHttp: never };
    if (specifier === '../../services/backendEvents') return { libraryChanged: never };
    throw new Error(`Unexpected runtime import: ${specifier}`);
  } }, { filename: file });
  return module.exports;
}
const { createEditorApi } = load('frontend/src/pages/editor/editorApi.ts');
const { letterProgress, buildLines, currentLineIndex, upcomingLinePhase } = load('frontend/src/features/karaoke/karaokeLyrics.ts');
function geometry(text) {
  const widths = [...text].map((c) => .4 + c.codePointAt(0) % 13 / 7);
  const total = widths.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return widths.map((width) => { const start = cursor; cursor += width / total; return [start, cursor]; });
}
const reference = JSON.parse(fs.readFileSync(args.reference, 'utf8'));
const requestedCases = args['cases-from'] ? new Set(JSON.parse(fs.readFileSync(args['cases-from'], 'utf8')).cases.map((c) => c.case)) : null;
if (requestedCases) for (const name of requestedCases) assert(reference.cases.some((c) => c.case === name), `Unknown case ${name}`);
const selectedCases = reference.cases.filter((c) => !requestedCases || requestedCases.has(c.case));
const rows = [], inputs = [];
for (const c of selectedCases) {
  const file = args['documents-dir'] ? path.join(args['documents-dir'], c.case, 'final/lyricsSync.json') : path.join(args['prediction-dir'], c.case, 'payload.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const document = args['documents-dir'] ? raw : {
    title: c.case, artist: 'data-level check', duration: c.duration, bpm: null, key: null,
    lyrics: c.lyrics, words: raw.words.map((w) => ({ ...w, notes: [] })),
  };
  const editor = await createEditorApi(async () => ({ songId: c.case, revision: 1, document })).load(c.case);
  assert.equal(editor.words.length, c.words.length);
  const lines = buildLines(editor.words, editor.lyrics, editor.bpm);
  inputs.push({ case: c.case, file, sha256: sha(file) });
  for (const truth of c.words) {
    const word = editor.words[truth.index];
    assert.equal(word.text.toLocaleLowerCase(), truth.text.toLocaleLowerCase());
    const ownLine = lines.findIndex((line) => line.words.some((item) => item.id === word.id));
    const early = (truth.start - word.end) * 1000;
    const late = (word.end - truth.end) * 1000;
    const row = { case: c.case, wordIndex: truth.index, word: word.text,
      referenceStart: truth.start, referenceEnd: truth.end,
      referenceAccuracyMs: truth.referenceAccuracyMs ?? null,
      predictedStart: word.start, predictedEnd: word.end,
      finishedBeforeReferenceStartMs: Math.round(early * 1000) / 1000,
      remainsAfterReferenceEndMs: Math.round(late * 1000) / 1000,
      savedLetters: document.words[truth.index].letters,
      ownLineIndex: ownLine, ownLineStart: lines[ownLine].start, ownLineEnd: lines[ownLine].end,
      geometry: {} };
    for (const mode of ['no-geometry', 'deterministic-nonuniform-widths']) {
      const widths = mode === 'no-geometry' ? undefined : geometry(word.text);
      const atStart = letterProgress(word, truth.start, widths), atEnd = letterProgress(word, truth.end, widths);
      row.geometry[mode] = { progressAtReferenceStart: atStart, progressAtReferenceEnd: atEnd,
        completeAtReferenceStart: atStart >= 1 - 1e-12,
        completeAtLeast50msBeforeReferenceStart: atStart >= 1 - 1e-12 && early >= 50 - 1e-9,
        incompleteAtReferenceEnd: atEnd < 1 - 1e-12,
        incompleteAtLeast50msAfterReferenceEnd: atEnd < 1 - 1e-12 && late >= 50 - 1e-9 };
    }
    row.lineSelection = [truth.start, (truth.start + truth.end) / 2, truth.end - 1e-7].map((moment, index) => {
      const active = currentLineIndex(lines, moment);
      const phase = upcomingLinePhase(lines, active, moment);
      return { checkpoint: ['reference-start', 'reference-middle', 'just-before-reference-end'][index],
        moment, activeLine: active, ownsReferenceWord: active === ownLine, phase,
        ownLineEndedAtLeast50msEarlier: moment - lines[ownLine].end >= .05 - 1e-9,
        laterLineSelectedAtLeast50msBeforeReferenceWordEnd: active > ownLine && truth.end - moment >= .05 - 1e-9 };
    });
    rows.push(row);
  }
}
for (const [relative, hash] of Object.entries(sourceHashes)) assert.equal(sha(path.join(repo, relative)), hash);
const counts = {};
for (const mode of ['no-geometry', 'deterministic-nonuniform-widths']) counts[mode] = Object.fromEntries([
  'completeAtReferenceStart', 'completeAtLeast50msBeforeReferenceStart',
  'incompleteAtReferenceEnd', 'incompleteAtLeast50msAfterReferenceEnd',
].map((field) => [field, rows.filter((r) => r.geometry[mode][field]).length]));
const report = {
  scope: 'Actual unchanged editorApi letterFractions and karaokeLyrics functions evaluated at frozen external author word labels. Labels have unspecified accuracy;50ms sensitivity separately avoids calling every tiny discrepancy a defect. All selected words retained. Deterministic geometry is not measured font geometry; no live Electron/browser/listening test.',
  mode: args['documents-dir'] ? 'final-lyricsSync' : 'payload-plus-empty-notes; final document layout not yet exercised',
  referenceSha256: sha(args.reference), selectionManifestSha256: args['cases-from'] ? sha(args['cases-from']) : null, unselectedCases: reference.cases.filter((c) => !selectedCases.includes(c)).map((c) => c.case), sourceHashes, sourceUnchanged: true, inputs,
  totalWords: rows.length, counts,
  wordsWithLaterLineAtLeast50msBeforeReferenceEnd: rows.filter((row) => row.lineSelection.some((p) => p.laterLineSelectedAtLeast50msBeforeReferenceWordEnd)).length,
  wordsHiddenInsideReferenceAtCheckpoints: rows.filter((row) => row.lineSelection.some((p) => p.phase.kind !== 'text')).length,
  rows,
};
fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ words: rows.length, counts,
  prematureLaterLines: report.wordsWithLaterLineAtLeast50msBeforeReferenceEnd,
  hiddenInsideReference: report.wordsHiddenInsideReferenceAtCheckpoints }));
for (const row of rows.filter((r) => r.geometry['no-geometry'].completeAtLeast50msBeforeReferenceStart)) {
  console.log(row.case, row.word, row.predictedStart, row.predictedEnd, 'reference', row.referenceStart, row.referenceEnd,
    'finishedBeforeStartMs', row.finishedBeforeReferenceStartMs);
}
