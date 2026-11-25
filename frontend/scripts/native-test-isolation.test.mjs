import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const executable = fileURLToPath(
  new URL(
    '../../AudioService/build/Release/audioservice_tests.exe',
    import.meta.url,
  ),
);
const run = promisify(execFile);

test(
  'isolated native partitions run every registered case exactly once',
  { skip: process.platform !== 'win32' || !existsSync(executable) },
  async (context) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'ad-voice-test-partitions-'),
    );
    context.after(() => rm(root, { recursive: true, force: true }));
    const source = await readFile(
      new URL('../../AudioService/tests/main.cpp', import.meta.url),
      'utf8',
    );
    const expected = [...source.matchAll(/Test\{\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    const actual = [];
    const options = {
      windowsHide: true,
      timeout: 180000,
      env: { ...process.env, TEMP: root, TMP: root },
    };
    for (let shard = 0; shard < 3; shard++) {
      const result = await run(executable, ['--shard', String(shard)], options);
      const names = [...result.stdout.matchAll(/\[ RUN\s+\] (\S+)/g)].map(
        (match) => match[1],
      );
      assert.deepEqual(
        names,
        expected.filter((_, index) => index % 3 === shard),
      );
      actual.push(...names);
    }
    assert.equal(new Set(actual).size, expected.length);
    assert.deepEqual(actual.toSorted(), expected.toSorted());
    for (const shard of ['-1', '3', 'bad', ''])
      await assert.rejects(
        run(executable, ['--shard', shard], options),
        (error) => error.code === 2,
      );
  },
);
test(
  'native test processes never delete a shared temporary directory',
  {
    skip: process.platform !== 'win32' || !existsSync(executable),
  },
  async (context) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'ad-voice-test-isolation-'),
    );
    context.after(() => rm(root, { recursive: true, force: true }));
    const shared = path.join(root, 'audioservice-tests');
    await mkdir(shared);
    const sentinel = path.join(shared, 'other-process.txt');
    await writeFile(sentinel, 'owned by another process');
    const options = {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, TEMP: root, TMP: root },
    };
    await assert.rejects(
      run(executable, ['unknown-test-name'], options),
      (error) => error.code === 2,
    );
    assert.equal(await readFile(sentinel, 'utf8'), 'owned by another process');
    await Promise.all(
      Array.from({ length: 4 }, () =>
        run(executable, ['wavDecoderReportsFormat'], options),
      ),
    );
    assert.equal(await readFile(sentinel, 'utf8'), 'owned by another process');
  },
);
