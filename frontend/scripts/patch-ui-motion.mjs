import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ad-voice/ui 2.7.14 checks layout before each decoration callback, after the
// preceding callback dirtied SVG styles. Read visibility once before any writes.
const changes = [
  ['    const d = U.roundedPath(w, h, r);',
   `    const d = U.roundedPath(w, h, r);
    if (item.geometry === d) return;
    item.geometry = d;`],
  ['    const p = path.getPointAtLength((time / (round ? 11 : 18) + 0.535) % 1 * item.length);',
   `    const position = (time / (round ? 11 : 18) + 0.535) % 1 * 64;
    const index = Math.floor(position), fraction = position - index;
    const from = item.points[index], to = item.points[index + 1];
    const p = {x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction};`],
  ['    item.length = path.getTotalLength();',
   `    item.length = path.getTotalLength();
    item.points = Array.from({length: 65}, (_, index) => path.getPointAtLength(index / 64 * item.length));`],
  ['    for (const animation of active) animation.currentTime = now - animation.__adStart;',
   `    const visibility = new Map();
    for (const scope of running) {
      for (const node of scope.callbacks.keys()) {
        if (!visibility.has(node))
          visibility.set(node, node.isConnected && node._adInView !== false && node.getClientRects().length > 0);
      }
    }
    for (const animation of active) animation.currentTime = now - animation.__adStart;`],
  ['    for (const scope of running) scope.tick(now);',
   '    for (const scope of running) scope.tick(now, visibility);'],
  ['    tick(now) {', '    tick(now, visibility) {'],
  ['        if (node.getClientRects().length && node._adInView !== false)',
   '        if (visibility ? visibility.get(node) : node.getClientRects().length && node._adInView !== false)'],
];

export function patchMotionSource(source) {
  // Upgrade installations patched by the earlier sampling version.
  source = source.replace(' % 1 * 512;', ' % 1 * 64;')
    .replace('length: 513}, (_, index) => path.getPointAtLength(index / 512',
      'length: 65}, (_, index) => path.getPointAtLength(index / 64');
  for (const [before, after] of changes) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2)
      throw new Error('UI motion patch no longer matches the dependency; review it before updating @ad-voice/ui.');
    source = source.replace(before, after);
  }
  return source;
}

// Procedural decoration must not generate multi-megapixel noise images while a
// dialog opens, or retain every size ever encountered during window resizing.
export function patchArtworkSource(source) {
  for (const [before, after] of [
    ['var BUDGET = 32e5;', 'var BUDGET = 512000;'],
    ['    paintings.set(id, done);', `    paintings.set(id, done);
    while (paintings.size > 24) paintings.delete(paintings.keys().next().value);`],
  ]) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2)
      throw new Error('UI artwork patch no longer matches the dependency; review it before updating @ad-voice/ui.');
    source = source.replace(before, after);
  }
  return source;
}

export async function patchUiMotion() {
  const directory = fileURLToPath(new URL('../node_modules/@ad-voice/ui/', import.meta.url));
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== '2.7.14') throw new Error(`Review UI motion patch for @ad-voice/ui ${pkg.version}`);
  const chunks = path.join(directory, 'dist/chunks');
  const files = await fs.readdir(chunks);
  let found = false;
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const target = path.join(chunks, file);
    const source = await fs.readFile(target, 'utf8');
    if (!source.includes('// src/core/motion-engine.js')) continue;
    const patched = patchMotionSource(source);
    if (patched !== source) await fs.writeFile(target, patched);
    found = true;
  }
  if (!found) throw new Error('UI motion engine not found; review dependency layout.');
  const artworkTarget = path.join(directory, 'dist/index.js');
  const artworkSource = await fs.readFile(artworkTarget, 'utf8');
  const artworkPatched = patchArtworkSource(artworkSource);
  if (artworkSource !== artworkPatched) await fs.writeFile(artworkTarget, artworkPatched);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  patchUiMotion().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
