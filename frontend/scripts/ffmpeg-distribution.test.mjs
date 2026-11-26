import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  prepareDistribution,
  sealDistribution,
  releaseArtifacts,
} from '../../scripts/ffmpeg-distribution.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ffmpeg-distribution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = (...parts) => path.join(root, ...parts);
  const put = (name, value) => {
    mkdirSync(path.dirname(at(name)), { recursive: true });
    writeFileSync(at(name), value);
  };
  const binaries = {
    'ffmpeg.exe': 'ffmpeg fixture',
    'ffprobe.exe': 'ffprobe fixture',
  };
  const source = Buffer.from(
    'PK\x03\x04corresponding source fixture with build instructions',
  );
  const manifest = {
    version: 'fixture-1',
    license: 'GPL-3.0-or-later',
    upstreamUrl: 'https://example.test/ffmpeg',
    binaries: Object.fromEntries(
      Object.entries(binaries).map(([name, bytes]) => [name, sha256(bytes)]),
    ),
    sourceArchive: {
      name: 'FFmpeg-fixture-corresponding-source.zip',
      sha256: sha256(source),
    },
    thirdPartyNotices: {
      name: 'FFmpeg-fixture-THIRD-PARTY-NOTICES.txt',
      sha256: sha256('Third-party notices fixture'),
    },
  };
  const save = () =>
    put('docs/third-party/ffmpeg/distribution.json', JSON.stringify(manifest));
  save();
  put('docs/third-party/ffmpeg/GPL-3.0.txt', 'GPL fixture');
  put('docs/third-party/ffmpeg/BUILD-INFO.txt', 'Build fixture');
  put('frontend/package.json', JSON.stringify({ version: '1.2.3' }));
  for (const [name, bytes] of Object.entries(binaries))
    put(`bin/${name}`, bytes);
  put('sources/' + manifest.sourceArchive.name, source);
  put(
    'sources/' + manifest.thirdPartyNotices.name,
    'Third-party notices fixture',
  );
  return {
    root,
    at,
    put,
    manifest,
    save,
    prepare: () =>
      prepareDistribution(
        root,
        at('bin/ffmpeg.exe'),
        at('bin/ffprobe.exe'),
        at('resources'),
        at('sources'),
      ),
  };
};

test('release preparation rejects missing or unreviewed corresponding sources', async (t) => {
  const f = fixture(t);
  f.manifest.sourceArchive.sha256 = null;
  f.save();
  await assert.rejects(f.prepare(), /corresponding source/i);
  f.manifest.sourceArchive.sha256 = '0'.repeat(64);
  f.save();
  await assert.rejects(f.prepare(), /SHA-256/i);
});

test('release preparation rejects an unrelated FFmpeg binary', async (t) => {
  const f = fixture(t);
  f.put('bin/ffprobe.exe', 'another build');
  await assert.rejects(f.prepare(), /ffprobe.exe.*SHA-256/i);
});

test('a relocated project carries its sources without an external cache or environment override', async (t) => {
  const f = fixture(t);
  for (const item of [f.manifest.sourceArchive, f.manifest.thirdPartyNotices])
    f.put('vendor/ffmpeg/' + item.name, readFileSync(f.at('sources', item.name)));
  rmSync(f.at('sources'), { recursive: true });
  const relocated = f.root + ' moved with spaces';
  renameSync(f.root, relocated);
  t.after(() => rmSync(relocated, { recursive: true, force: true }));
  const previous = process.env.AD_VOICE_FFMPEG_SOURCE_DIR;
  process.env.AD_VOICE_FFMPEG_SOURCE_DIR = f.at('missing-external-cache');
  t.after(() => {
    if (previous === undefined) delete process.env.AD_VOICE_FFMPEG_SOURCE_DIR;
    else process.env.AD_VOICE_FFMPEG_SOURCE_DIR = previous;
  });
  const resources = path.join(relocated, 'resources');
  await prepareDistribution(
    relocated,
    path.join(relocated, 'bin/ffmpeg.exe'),
    path.join(relocated, 'bin/ffprobe.exe'),
    resources,
  );
  assert.equal(
    sha256(readFileSync(path.join(resources, 'docs/third-party/ffmpeg', f.manifest.sourceArchive.name))),
    f.manifest.sourceArchive.sha256,
  );
});

test('the source package and both binaries are bound to the signed installer', async (t) => {
  const f = fixture(t);
  await f.prepare();
  assert.match(
    readFileSync(f.at('resources/docs/third-party/ffmpeg/NOTICE.txt'), 'utf8'),
    /v1\.2\.3\/FFmpeg-fixture-corresponding-source.zip/,
  );
  assert.equal(
    readFileSync(f.at('resources/tools/ffmpeg.exe'), 'utf8'),
    'ffmpeg fixture',
  );
  assert.ok(readFileSync(f.at('resources/docs/third-party/ffmpeg', f.manifest.sourceArchive.name)).length > 0);
  await assert.rejects(releaseArtifacts(f.root), /seal|manifest|ENOENT/i);
  f.put('release/AD-Voice-Setup.exe', 'signed installer');
  await sealDistribution(f.root);
  assert.equal((await releaseArtifacts(f.root)).length, 3);
  f.put('release/AD-Voice-Setup.exe', 'changed installer');
  await assert.rejects(releaseArtifacts(f.root), /SHA-256/i);
});

test('publication rejects changed source archives and stale application versions', async (t) => {
  const f = fixture(t);
  await f.prepare();
  f.put('release/AD-Voice-Setup.exe', 'installer');
  await sealDistribution(f.root);
  f.put('release/' + f.manifest.sourceArchive.name, 'changed archive');
  await assert.rejects(releaseArtifacts(f.root), /SHA-256/i);
  await f.prepare();
  await sealDistribution(f.root);
  f.put('frontend/package.json', JSON.stringify({ version: '1.2.4' }));
  await assert.rejects(releaseArtifacts(f.root), /version/i);
});
