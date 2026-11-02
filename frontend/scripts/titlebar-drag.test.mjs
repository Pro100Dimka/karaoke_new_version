import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the free title-bar area drags the window while its controls stay clickable', () => {
  const titlebar = readFileSync(
    new URL('../src/app/TitleBar.tsx', import.meta.url),
    'utf8',
  );
  // Pointer capture handles both true fullscreen and modal top layers, where a native drag region fails.
  assert.match(
    titlebar,
    /document\.addEventListener\(\s*["']pointerdown["'],\s*down,\s*options\s*\)/,
  );
  assert.match(titlebar, /setPointerCapture/);
  assert.match(titlebar, /desktopClient\.dragWindow\(\s*["']start["']/);
  assert.match(
    titlebar,
    /target\.closest\(\s*["']button, a, input, textarea, select, label,/,
  );
});
