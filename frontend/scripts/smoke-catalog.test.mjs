import assert from 'node:assert/strict';
import test from 'node:test';
import { clientSongs, clientRoom } from './smoke-catalog.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('room snapshots use the selected authenticated profile and propagate failures', async () => {
  const requests = [];
  globalThis.window = {
    desktop: {
      roomRequest: async (request) => {
        requests.push(request);
        return { ok: true, status: 200, body: { roomId: 'room' } };
      },
    },
  };
  try {
    assert.deepEqual(
      await clientRoom({ evaluate: (query, code) => query(code) }, 'room/name'),
      { roomId: 'room' },
    );
    assert.deepEqual(requests, [{ method: 'GET', path: '/rooms/room%2Fname' }]);
    for (const response of [
      { ok: false, status: 403 },
      { ok: true, status: 200, body: {} },
    ])
      await assert.rejects(
        clientRoom({ evaluate: async () => response }, 'room'),
        /Client room snapshot failed/,
      );
  } finally {
    delete globalThis.window;
  }
});

test("room catalog queries use the selected client's backend bridge", async () => {
  const requests = [];
  const songs = Array.from({ length: 201 }, (_, index) => ({
    songId: `profile-song-${index}`,
  }));
  globalThis.window = {
    desktop: {
      pythonRequest: async (request) => {
        requests.push(request);
        const offset = Number(
          new URL(request.path, 'http://localhost').searchParams.get('offset'),
        );
        return {
          ok: true,
          status: 200,
          body: {
            items: songs.slice(offset, offset + 200),
            total: songs.length,
            limit: 200,
          },
        };
      },
    },
  };
  try {
    assert.deepEqual(
      await clientSongs({ evaluate: (query, route) => query(route) }),
      songs,
    );
    assert.deepEqual(requests, [
      { method: 'GET', path: '/songs?limit=200' },
      { method: 'GET', path: '/songs?limit=200&offset=200' },
    ]);
  } finally {
    delete globalThis.window;
  }
});

test('project-transfer cleanup preserves pre-existing remapped songs', async () => {
  const source = readFileSync(
    new URL('../electron/live-room-project-smoke.mjs', import.meta.url),
    'utf8',
  );
  const cleanup = source.slice(
    source.lastIndexOf('} finally {') + '} finally {'.length,
    source.lastIndexOf('}'),
  );
  for (const [importedSongId, importCreated] of [
    [undefined, false],
    ['existing-local', false],
    ['concurrent-local', false],
    ['unknown-import', undefined],
    ['created-by-transfer', true],
  ]) {
    const requests = [];
    await runInNewContext(`(async () => { ${cleanup} })()`, {
      importedSongId,
      importCreated,
      installedIds: new Set(['existing-local']),
      installedBackend: 'isolated-test-backend',
      roomId: undefined,
      temporaryRoot: 'isolated-test-files',
      json: async (base, route, init) =>
        requests.push([base, route, init.method]),
      rm: async () => undefined,
    });
    assert.deepEqual(
      requests,
      importedSongId === 'created-by-transfer'
        ? [['isolated-test-backend', '/songs/created-by-transfer', 'DELETE']]
        : [],
    );
  }
});

test('room catalog failures are reported instead of becoming an empty ready library', async () => {
  for (const response of [
    { ok: false, status: 503 },
    { ok: true, status: 200, body: {} },
  ]) {
    await assert.rejects(
      clientSongs({ evaluate: async () => response }),
      /Client song catalog failed/,
    );
  }
});

for (const file of [
  'live-room-release-e2e.mjs',
  'live-social-e2e.mjs',
  '../electron/network-room-server-vocal-process-test.mjs',
]) {
  test(`${file} returns a failure exit code for a failed report`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const native = file.includes('/electron/');
    const finalization = native
      ? source.match(
          /  console\.log\(JSON.stringify\(report\)\);[\s\S]*?(?=\n} catch)/,
        )?.[0]
      : source.slice(
          source.lastIndexOf('} finally {') + '} finally {'.length,
          source.lastIndexOf('}'),
        );
    assert.ok(finalization, file);
    for (const passed of [false, true]) {
      const process = { exitCode: 0, exit() {} };
      runInNewContext(finalization, {
        report: { checks: [{ passed }], result: passed ? 'PASS' : 'FAIL' },
        process,
        writeFileSync() {},
        join: (...parts) => parts.join('/'),
        out: 'evidence',
        console: { log() {} },
      });
      assert.equal(
        process.exitCode,
        passed ? 0 : 1,
        `${file}: passed=${passed}`,
      );
    }
  });
}
