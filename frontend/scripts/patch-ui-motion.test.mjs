import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { patchMotionSource, patchArtworkSource, assertSupportedUiVersion } from './patch-ui-motion.mjs';

test('UI patch accepts the reviewed 2.7.17 release and rejects unknown releases', () => {
  assert.doesNotThrow(() => assertSupportedUiVersion('2.7.17'));
  assert.throws(() => assertSupportedUiVersion('2.7.18'), /Review UI motion patch/);
});

test('installed 2.8.0 UI passes the postinstall compatibility check', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../node_modules/@ad-voice/ui/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '2.8.0');
  assert.doesNotThrow(() => assertSupportedUiVersion(pkg.version));
});

test('motion engine batches layout reads across scopes before decoration writes', async () => {
  const chunks = new URL('../node_modules/@ad-voice/ui/dist/chunks/', import.meta.url);
  const files = await fs.readdir(chunks);
  let source;
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const candidate = await fs.readFile(new URL(file, chunks), 'utf8');
    if (candidate.includes('// src/core/motion-engine.js')) source = candidate;
  }
  assert.ok(source);
  const patched = patchMotionSource(source);
  assert.equal(patchMotionSource(patched), patched);
  const engine = patched.slice(patched.indexOf('// src/core/motion-engine.js'), patched.indexOf('// src/core/motion/hooks.ts'));
  const events = [];
  const context = vm.createContext({
    document: { hidden: false, documentElement: {dataset: {}} },
    navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    performance: {now: () => 100},
    HTMLElement: class {},
    reducedMotionQuery: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    canObserveIntersection: () => false,
    events,
  });
  vm.runInContext(engine, context);
  vm.runInContext(`
    const node = name => ({isConnected: true, getClientRects() {events.push('read:' + name); return [1];}});
    const first = U.createMotion(), second = U.createMotion();
    first.add(node('a'), () => events.push('write:a'));
    second.add(node('b'), () => events.push('write:b'));
    second.add({...node('hidden'), _adInView: false}, () => events.push('write:hidden'));
    events.length = 0;
    tick(100);
  `, context);
  assert.deepEqual(events, ['read:a', 'read:b', 'write:a', 'write:b']);
  let geometryReads = 0, lengthReads = 0;
  context.createResizeObserver = () => ({observe() {}, disconnect() {}});
  context.getComputedStyle = () => ({position: 'relative', borderTopLeftRadius: '12px'});
  context.makeSvg = () => ({
    setAttribute() {}, append() {}, style: {},
    getTotalLength() { lengthReads++; return 400; },
    getPointAtLength(length) { geometryReads++; return {x: length, y: 0}; },
  });
  vm.runInContext(`
    U.svg = makeSvg;
    const border = U.attachBorder({style: {}, append() {}, offsetWidth: 120, offsetHeight: 80});
  `, context);
  assert.equal(geometryReads, 0, 'the analytic contour must not sample SVG points');
  assert.equal(lengthReads, 1);
  vm.runInContext('border.sync();', context);
  assert.equal(lengthReads, 1, 'unchanged dimensions must reuse geometry');
  vm.runInContext('for (let i = 0; i < 100; i++) border.paint(i / 30);', context);
  assert.equal(geometryReads, 0, 'animation frames must not query SVG geometry');
  assert.equal(lengthReads, 1, 'animation frames must not recalculate SVG length');
});

test('dependency drift fails explicitly instead of silently dropping the fix', () => {
  assert.throws(() => patchMotionSource('unrecognized motion implementation'), /no longer matches/);
});

test('procedural artwork has a bounded cache and bounded pixel cost', async () => {
  const source = await fs.readFile(new URL('../node_modules/@ad-voice/ui/dist/index.js', import.meta.url), 'utf8');
  const patched = patchArtworkSource(source);
  assert.equal(patchArtworkSource(patched), patched);
  const cache = patched.slice(patched.indexOf('var paintings ='), patched.indexOf('// src/components/artwork/useArtwork.ts'));
  const context = vm.createContext({ document: { createElement: () => ({ getContext: () => null }) }, setTimeout });
  vm.runInContext(cache, context);
  await vm.runInContext(`(async () => {
    for (let i = 0; i < 100; i++) await paintCanvas('test' + i, 100, 100, {});
  })()`, context);
  assert.equal(vm.runInContext('paintings.size', context), 24);
  assert.equal(vm.runInContext('paintCanvas("test99", 100, 100, {}) === paintings.get("test99:100x100")', context), true);
  const budget = Number(patched.match(/var BUDGET = (\d+);/)[1]);
  assert.ok(budget <= 512000);
  assert.throws(() => patchArtworkSource('changed dependency'), /no longer matches/);
});
