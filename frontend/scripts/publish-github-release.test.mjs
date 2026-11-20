import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const payload = Buffer.from(
  Array.from({ length: 4096 }, (_, index) => index % 251),
);
const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
const target = '0123456789abcdef0123456789abcdef01234567';
const notes = '# Версия 1.2.3\n\nИсправлено открытие файлов и списков. 🎤\n';
const uploaded = {
  id: 321,
  name: 'AD-Voice-Setup.exe',
  size: payload.length,
  state: 'uploaded',
  digest,
};

const runPublisher = (t, options = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'ad-voice-publisher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'frontend', 'release'])
    mkdirSync(join(root, directory));
  const script = join(root, 'scripts', 'publish-github-release.mjs');
  writeFileSync(
    script,
    readFileSync(
      new URL('../../scripts/publish-github-release.mjs', import.meta.url),
    ),
  );
  writeFileSync(
    join(root, 'frontend', 'package.json'),
    JSON.stringify({ version: '1.2.3' }),
  );
  writeFileSync(join(root, 'release', uploaded.name), payload);
  writeFileSync(join(root, 'release-notes.md'), notes);
  writeFileSync(
    join(root, 'plan.json'),
    JSON.stringify({
      asset: uploaded,
      tagCommit: target,
      ...options,
    }),
  );
  const preload = join(root, 'github-boundary.mjs');
  writeFileSync(
    preload,
    `
import { appendFileSync, readFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
const events = new URL('./requests.jsonl', import.meta.url);
const record = (event) => appendFileSync(events, JSON.stringify(event) + '\\n');
const release = { id: 123, draft: true, html_url: 'https://example.test/release/v1.2.3' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
let polls = 0;
let refReads = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(String(url));
  const method = options.method ?? 'GET';
  record({
    kind: 'request', url: address.href, method,
    headers: Object.fromEntries(new Headers(options.headers)),
    body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    binary: options.body instanceof Uint8Array ? Buffer.from(options.body).toString('base64') : undefined,
  });
  if (method === 'GET' && address.pathname.endsWith('/releases/tags/v1.2.3'))
    return response({}, plan.existingStatus ?? 404);
  if (method === 'GET' && address.pathname.endsWith('/git/ref/tags/v1.2.3'))
    return response({
      ref: 'refs/tags/v1.2.3',
      object: { type: plan.tagType ?? 'commit', sha: plan.tagType === 'tag' ? 'a'.repeat(40) : plan.tagCommit },
    }, plan.refStatuses?.[refReads++] ?? plan.refStatus ?? 404);
  if (method === 'POST' && address.pathname.endsWith('/git/refs'))
    return response({ ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: plan.tagCommit } }, plan.refCreateStatus ?? 201);
  if (method === 'GET' && address.pathname.endsWith('/commits/v1.2.3'))
    return response({ sha: plan.tagCommit }, plan.commitStatus ?? 200);
  if (method === 'POST' && address.pathname.endsWith('/releases'))
    return response(release, 201);
  if (method === 'POST' && address.hostname === 'uploads.github.com' && address.pathname.endsWith('/releases/123/assets'))
    return response(plan.asset, plan.uploadStatus ?? 201);
  if (method === 'GET' && address.pathname.endsWith('/releases/assets/321')) {
    const asset = plan.pollAssets?.[polls++] ?? plan.asset;
    return response(asset, plan.pollStatus ?? 200);
  }
  if (method === 'PATCH' && address.pathname.endsWith('/releases/123'))
    return response({ ...release, draft: false });
  throw new Error('Unexpected GitHub request: ' + method + ' ' + address.href);
};
// The boundary is in-memory; retain the polling sequence without waiting in real time.
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  record({ kind: 'wait', milliseconds });
  queueMicrotask(() => callback(...args));
  return { unref() {} };
};
`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, script, ...(options.args ?? [])],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: 'test-release-token' },
      timeout: 10_000,
    },
  );
  assert.equal(result.signal, null, `${result.error ?? ''}\n${result.stderr}`);
  const log = join(root, 'requests.jsonl');
  const events = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  return {
    ...result,
    requests: events.filter((event) => event.kind === 'request'),
  };
};

const creation = (result) =>
  result.requests.find(
    (request) => request.method === 'POST' && request.url.endsWith('/releases'),
  );
const published = (result) =>
  result.requests.filter((request) => request.method === 'PATCH');
const assetReads = (result) =>
  result.requests.filter(
    (request) =>
      request.method === 'GET' && request.url.includes('/releases/assets/'),
  );

test('publishes verified bytes from the exact requested commit with UTF-8 release notes', (t) => {
  const result = runPublisher(t, {
    args: ['--target', target, '--notes-file', 'release-notes.md'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(creation(result)?.body, {
    tag_name: 'v1.2.3',
    target_commitish: target,
    name: 'A&D Voice 1.2.3',
    body: notes,
    draft: true,
    prerelease: false,
  });
  assert.deepEqual(
    result.requests.map((request) => request.method),
    ['GET', 'GET', 'POST', 'POST', 'POST', 'PATCH'],
  );
  assert.equal(
    result.requests[1].url,
    'https://api.github.com/repos/Pro100Dimka/karaoke_new_version/git/ref/tags/v1.2.3',
  );
  assert.equal(
    result.requests[2].url,
    'https://api.github.com/repos/Pro100Dimka/karaoke_new_version/git/refs',
  );
  assert.deepEqual(result.requests[2].body, {
    ref: 'refs/tags/v1.2.3',
    sha: target,
  });
  assert.equal(
    result.requests[2].headers.authorization,
    'Bearer test-release-token',
  );
  const upload = result.requests[4];
  assert.equal(
    upload.url,
    'https://uploads.github.com/repos/Pro100Dimka/karaoke_new_version/releases/123/assets?name=AD-Voice-Setup.exe',
  );
  assert.equal(upload.headers['content-length'], String(payload.length));
  assert.deepEqual(Buffer.from(upload.binary, 'base64'), payload);
  assert.deepEqual(published(result)[0].body, { draft: false });
});

test('preserves the default target and inline --notes argument', (t) => {
  const result = runPublisher(t, {
    args: ['--notes', 'Inline notes\nSecond line'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Object.hasOwn(creation(result).body, 'target_commitish'), false);
  assert.equal(creation(result).body.body, 'Inline notes\nSecond line');
  assert.equal(
    result.requests.some((request) => /\/(git|commits)\//.test(request.url)),
    false,
  );
  assert.equal(published(result).length, 1);
});

test('rejects a pre-existing tag on a different commit before creating a draft', (t) => {
  const result = runPublisher(t, {
    args: ['--target', target],
    refStatus: 200,
    tagCommit: 'f'.repeat(40),
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(creation(result), undefined);
  assert.equal(
    result.requests.some((request) => request.method !== 'GET'),
    false,
  );
});

for (const tagType of ['commit', 'tag'])
  test(`accepts an existing ${tagType === 'tag' ? 'annotated' : 'lightweight'} tag only after resolving the requested commit`, (t) => {
    const result = runPublisher(t, {
      args: ['--target', target],
      refStatus: 200,
      tagType,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.requests[2].url,
      'https://api.github.com/repos/Pro100Dimka/karaoke_new_version/commits/v1.2.3',
    );
    assert.equal(result.requests[2].method, 'GET');
    assert.equal(
      result.requests.some(
        (request) =>
          request.method === 'POST' && request.url.endsWith('/git/refs'),
      ),
      false,
    );
    assert.equal(creation(result).body.target_commitish, target);
    assert.equal(published(result).length, 1);
  });

for (const status of [409, 422]) {
  test(`rejects a tag-creation HTTP ${status} race won by a different commit`, (t) => {
    const result = runPublisher(t, {
      args: ['--target', target],
      refStatuses: [404, 200],
      refCreateStatus: status,
      tagCommit: 'f'.repeat(40),
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(creation(result), undefined);
    assert.deepEqual(
      result.requests.map((request) => request.method),
      ['GET', 'GET', 'POST', 'GET', 'GET'],
    );
  });
  test(`continues a tag-creation HTTP ${status} race only for the same commit`, (t) => {
    const result = runPublisher(t, {
      args: ['--target', target],
      refStatuses: [404, 200],
      refCreateStatus: status,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.requests.slice(0, 5).map((request) => request.method),
      ['GET', 'GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(creation(result).body.target_commitish, target);
    assert.equal(published(result).length, 1);
  });
}

for (const status of [403, 503])
  test(`does not create a release when the existing-release lookup fails with HTTP ${status}`, (t) => {
    const result = runPublisher(t, {
      args: ['--target', target],
      existingStatus: status,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.requests.length, 1);
    assert.equal(creation(result), undefined);
  });

test('--draft uploads and verifies the installer without publishing it', (t) => {
  const result = runPublisher(t, { args: ['--draft'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(creation(result).body.draft, true);
  assert.equal(published(result).length, 0);
  assert.match(result.stdout, /\(draft\)/);
});

for (const args of [
  ['--target', 'main'],
  ['--target', '0123456'],
  ['--target'],
  ['--notes-file'],
  ['--notes-file', 'missing.md'],
])
  test(`rejects invalid publication arguments before contacting GitHub: ${args.join(' ')}`, (t) => {
    const result = runPublisher(t, { args });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.requests, []);
  });

for (const [name, changes] of [
  ['wrong asset name', { name: 'another.exe' }],
  ['wrong size', { size: payload.length + 1 }],
  ['incomplete upload', { state: 'starter' }],
  ['mismatched SHA-256', { digest: `sha256:${'0'.repeat(64)}` }],
  ['unsupported digest', { digest: `sha512:${'0'.repeat(128)}` }],
])
  test(`leaves the release draft when GitHub returns ${name}`, (t) => {
    const result = runPublisher(t, { asset: { ...uploaded, ...changes } });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(creation(result).body.draft, true);
    assert.equal(published(result).length, 0);
    assert.equal(assetReads(result).length, 0);
  });

test('waits for an authenticated asset read to confirm a pending digest before publication', (t) => {
  const result = runPublisher(t, {
    asset: { ...uploaded, digest: null },
    pollAssets: [{ ...uploaded, digest: null }, uploaded],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.requests.map((request) => request.method),
    ['GET', 'POST', 'POST', 'GET', 'GET', 'PATCH'],
  );
  for (const request of assetReads(result)) {
    assert.equal(
      request.url,
      'https://api.github.com/repos/Pro100Dimka/karaoke_new_version/releases/assets/321',
    );
    assert.equal(request.headers.authorization, 'Bearer test-release-token');
    assert.equal(request.headers.accept, 'application/vnd.github+json');
  }
  assert.equal(published(result).length, 1);
});

for (const pendingDigest of [null, undefined])
  test(`leaves the release draft after bounded waiting for a ${pendingDigest} digest`, (t) => {
    const result = runPublisher(t, {
      asset: { ...uploaded, digest: pendingDigest },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(assetReads(result).length, 5);
    assert.equal(published(result).length, 0);
  });

for (const [name, options] of [
  [
    'digest mismatch',
    { pollAssets: [{ ...uploaded, digest: `sha256:${'0'.repeat(64)}` }] },
  ],
  ['changed size', { pollAssets: [{ ...uploaded, size: 1 }] }],
  ['GitHub error', { pollStatus: 503 }],
])
  test(`keeps the draft if pending asset verification returns ${name}`, (t) => {
    const result = runPublisher(t, {
      asset: { ...uploaded, digest: null },
      ...options,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(assetReads(result).length, 1);
    assert.equal(published(result).length, 0);
  });

test('never publishes after the installer upload fails', (t) => {
  const result = runPublisher(t, { uploadStatus: 502 });
  assert.notEqual(result.status, 0);
  assert.equal(creation(result).body.draft, true);
  assert.equal(published(result).length, 0);
  assert.equal(assetReads(result).length, 0);
});

test('does not overwrite an existing release', (t) => {
  const result = runPublisher(t, { existingStatus: 200 });
  assert.notEqual(result.status, 0);
  assert.equal(result.requests.length, 1);
  assert.equal(creation(result), undefined);
});
