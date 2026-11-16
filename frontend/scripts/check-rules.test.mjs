import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('syntax rules distinguish source constructs from strings and comments', () => {
  const root = mkdtempSync(join(tmpdir(), 'advoice-rule-test-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'electron'));
    const source = join(root, 'electron', 'sample.ts');
    const check = () =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./check-rules.mjs', import.meta.url))],
        { cwd: root, encoding: 'utf8' },
      );
    writeFileSync(
      source,
      '// Combine any number of signals.\nconst signal = AbortSignal.any([]);\nconst label = "any";\n',
    );
    assert.equal(check().status, 0);
    writeFileSync(source, 'let value:\n any;\n');
    const rejected = check();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /sample\.ts:2 any/);
    writeFileSync(source, 'const selector = "[role=\'button\']";\n');
    const renderer = join(root, 'src', 'sample.tsx');
    writeFileSync(renderer, 'const selector = "[role=\'button\']";\n');
    assert.equal(check().status, 0);
    for (const role of ['"button"', '{"button"}']) {
      writeFileSync(renderer, `const control = <span\n role = ${role} />;\n`);
      const invalidRole = check();
      assert.equal(invalidRole.status, 1);
      assert.match(invalidRole.stderr, /sample\.tsx:2 manual button role/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
