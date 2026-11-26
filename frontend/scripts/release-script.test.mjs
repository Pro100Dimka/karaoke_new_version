import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime install verification scripts are included in a fresh checkout', () => {
  const root = new URL('../../', import.meta.url);
  const cmake = readFileSync(new URL('AudioService/CMakeLists.txt', root), 'utf8');
  const scripts = [...cmake.matchAll(/-P "\$\{CMAKE_CURRENT_SOURCE_DIR\}\/([^"]+)"/g)];
  assert.ok(scripts.length > 0);
  for (const [, relative] of scripts) {
    const file = `AudioService/${relative}`;
    assert.ok(readFileSync(new URL(file, root), 'utf8').length > 0, file);
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], { cwd: root });
    assert.equal(ignored.status, 1, `${file} must not be excluded from source control`);
  }
});

test('release fingerprint changes when shipped relay or executable policies change', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ad-voice-release-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  const script = join(root, 'scripts', 'release-inputs.mjs');
  writeFileSync(
    script,
    readFileSync(new URL('../../scripts/release-inputs.mjs', import.meta.url)),
  );
  const fingerprint = (signing = {}) => {
    const result = spawnSync(
      process.execPath,
      [script, 'env', 'python', 'ffmpeg', 'ffprobe'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          AD_VOICE_SIGN_CERT: '',
          AD_VOICE_SIGN_THUMBPRINT: '',
          AD_VOICE_SIGN_TIMESTAMP: '',
          ...signing,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/);
    return result.stdout.trim();
  };
  for (const relative of [
    'AudioService/build-release/Release/NativeVoiceRelay.exe',
    'frontend/scripts/harden-electron.mjs',
    'scripts/sign-release.bat',
    'scripts/ffmpeg-distribution.mjs',
    'docs/third-party/ffmpeg/distribution.json',
    'docs/legal/third-party-licenses.en.md',
  ]) {
    await t.test(relative, () => {
      const file = join(root, relative);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'before');
      const before = fingerprint();
      assert.equal(
        fingerprint(),
        before,
        'unchanged inputs must keep the cache reusable',
      );
      writeFileSync(file, 'after!');
      assert.notEqual(
        fingerprint(),
        before,
        'changed release input must invalidate the old installer',
      );
    });
  }
  await t.test(
    'enabling or changing signing invalidates an unsigned installer',
    () => {
      const unsigned = fingerprint();
      const signing = { AD_VOICE_SIGN_THUMBPRINT: 'test-certificate' };
      assert.notEqual(fingerprint(signing), unsigned);
      assert.notEqual(
        fingerprint({
          ...signing,
          AD_VOICE_SIGN_TIMESTAMP: 'https://timestamp.example.test',
        }),
        fingerprint(signing),
      );
      const certificate = join(root, 'signing.pfx');
      writeFileSync(certificate, 'test-certificate-v1');
      const config = { AD_VOICE_SIGN_CERT: certificate };
      const before = fingerprint(config);
      writeFileSync(certificate, 'test-certificate-v2');
      assert.notEqual(
        fingerprint(config),
        before,
        'renewed certificates at the same path must be signed again',
      );
    },
  );
});

const release = readFileSync(
  new URL('../../release.bat', import.meta.url),
  'utf8',
);
const installer = readFileSync(
  new URL('../../installer/ad-voice.iss', import.meta.url),
  'utf8',
);
const developerSetup = readFileSync(
  new URL('../../installer.bat', import.meta.url),
  'utf8',
);
const runtimeVerifier = readFileSync(
  new URL('../../installer/verify_runtime.py', import.meta.url),
  'utf8',
);
const buildSteps = readFileSync(
  new URL('../../scripts/build-steps.mjs', import.meta.url),
  'utf8',
);
const findIscc = readFileSync(
  new URL('../../scripts/find-iscc.bat', import.meta.url),
  'utf8',
);

test(
  'public release ignores developer secrets and private bundling requires an explicit file',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'advoice-release-env-'));
    try {
      mkdirSync(join(root, 'python'));
      mkdirSync(join(root, 'local-secrets', 'env'), { recursive: true });
      const example = join(root, 'python', '.env.example');
      const privateFile = join(root, 'local-secrets', 'env', 'python.env');
      writeFileSync(example, '');
      writeFileSync(privateFile, 'TEST_KEY=not-a-real-key\n');
      const selector = join(root, 'select.bat');
      writeFileSync(
        selector,
        release.slice(0, release.indexOf('cd /d "%ROOT%"')) +
          '\necho SELECTED:%RELEASE_ENV%\nexit /b 0\n:fail\nexit /b 1\n',
      );
      const select = (args = []) =>
        spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/c', selector, ...args],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env, AD_VOICE_ENV_FILE: privateFile },
          },
        );
      const selected = (result) =>
        result.stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith('SELECTED:'))
          ?.slice(9);
      const publicBuild = select();
      assert.equal(publicBuild.status, 0);
      assert.equal(selected(publicBuild), example);
      const privateBuild = select(['--private-env', privateFile]);
      assert.equal(privateBuild.status, 0);
      assert.equal(selected(privateBuild), privateFile);
      assert.equal(
        select(['--private-env', join(root, 'absent.env')]).status,
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('release uses an isolated native build and installs its compiler runtime', () => {
  assert.doesNotMatch(release, /-B "%AUDIO%\\build"/i);
  assert.match(
    release,
    /cmake\.exe --install[^\r\n]*--component AudioServiceRuntime/i,
  );
  assert.doesNotMatch(release, /copy \/y "%PYTHON_BASE%\\(?:vcruntime|msvcp)/i);
});

test('developer setup retains native regression tests in its shared build directory', () => {
  const setup = readFileSync(
    new URL('../../installer.bat', import.meta.url),
    'utf8',
  );
  assert.ok(!setup.includes('-DAUDIOSERVICE_BUILD_TESTS=OFF'));
});

test('release produces a conventional offline Setup.exe without ISO media', () => {
  const build = `${release}\n${buildSteps}`;
  assert.match(build, /npx vite build/i);
  assert.match(build, /electron:compile/i);
  assert.match(build, /cmake[^\r\n]*--build/i);
  assert.match(release, /"%ISCC%"/i);
  assert.match(release, /AD-Voice-Setup\.exe/i);
  assert.doesNotMatch(release, /create_release_iso\.py/i);
  assert.doesNotMatch(release, /AD-Voice-Setup\.iso/i);
  assert.match(release, /\.env/i);
  assert.match(release, /\/XF[^\r\n]*\.env/i);
});

test('the installed app bundles Electron, Python, AudioService and FFmpeg', () => {
  assert.match(release, /node_modules\\electron\\dist/i);
  assert.match(release, /python-runtime/i);
  assert.match(release, /site-packages/i);
  assert.match(release, /audio-service/i);
  assert.match(release, /ffmpeg\.exe/i);
});

test('release and developer setup use the FFmpeg kit kept inside the project', () => {
  assert.match(release, /set "FFMPEG_EXE=%ROOT%vendor\\ffmpeg\\bin\\ffmpeg\.exe"/);
  assert.match(release, /set "FFPROBE_EXE=%ROOT%vendor\\ffmpeg\\bin\\ffprobe\.exe"/);
  assert.doesNotMatch(release, /Caches\\ffmpeg/i);
  assert.match(developerSetup, /%ROOT%vendor\\ffmpeg\\bin/);
  assert.doesNotMatch(developerSetup, /Gyan\.FFmpeg/);
  for (const file of [
    'vendor/ffmpeg/bin/ffmpeg.exe',
    'vendor/ffmpeg/bin/ffprobe.exe',
    'vendor/ffmpeg/FFmpeg-8.1.2-advoice1-corresponding-source.zip',
    'vendor/ffmpeg/FFmpeg-8.1.2-advoice1-THIRD-PARTY-NOTICES.txt',
  ]) {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], {
      cwd: new URL('../../', import.meta.url),
    });
    assert.equal(ignored.status, 1, `${file} must be included in source control`);
    const attributes = spawnSync('git', ['check-attr', 'text', '--', file], {
      cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    });
    assert.equal(attributes.status, 0, attributes.stderr);
    assert.ok(attributes.stdout.trim().endsWith(': text: unset'), `${file} must retain its pinned bytes after checkout`);
  }
});

test('the installed app bundles the processing backend without the Kaggle payload', () => {
  assert.match(
    release,
    /robocopy "%PYTHON%\\backend" "%RESOURCES%\\python-app\\backend"/i,
  );
  assert.doesNotMatch(
    release,
    /ad_voice_p100\.ipynb|ad_voice_server\.py|build_notebook\.py/i,
  );
});

test('release preserves corresponding sources and checks them before building or reusing Setup', () => {
  const prepare = release.indexOf('ffmpeg-distribution.mjs" prepare');
  const build = release.indexOf('scripts\\build-steps.mjs" release');
  assert.ok(prepare > 0 && prepare < build);
  const cached = release.slice(release.indexOf('if exist "%SETUP%" if'), release.indexOf('rem Copy and compress'));
  assert.match(cached, /ffmpeg-distribution\.mjs" verify-release/);
  assert.doesNotMatch(release, /for[^\r\n]*%RELEASE%[^\r\n]*(?:del \/q|rmdir)/i);
  const signed = release.indexOf('sign-release.bat" "%SETUP%"');
  const sealed = release.indexOf('ffmpeg-distribution.mjs" seal');
  assert.ok(sealed > signed);
});

test('a private release bundles the configured environment without printing its values', () => {
  assert.ok(release.includes('--private-env'));
  assert.ok(
    release.includes('copy /y "%RELEASE_ENV%" "%RESOURCES%\\python-app\\.env"'),
  );
  assert.doesNotMatch(release, /type "%RELEASE_ENV%"/i);
});

test('the branded icon is embedded into the installed executable before Setup is built', () => {
  assert.match(release, /stamp-exe-icon\.mjs/i);
  const iconCreatedAt = release.search(/ad-voice\.ico/i);
  const executableStampedAt = release.search(/stamp-exe-icon\.mjs/i);
  const setupBuiltAt = release.lastIndexOf('"%ISCC%"');
  assert.ok(iconCreatedAt >= 0 && executableStampedAt > iconCreatedAt);
  assert.ok(setupBuiltAt > executableStampedAt);
});

test('the installer defaults to the first fixed drive outside C and falls back to the user profile', () => {
  assert.match(installer, /DefaultDirName=\{code:GetDefaultDirName\}/i);
  assert.match(installer, /GetDriveTypeW@kernel32\.dll/i);
  assert.match(installer, /DRIVE_FIXED\s*=\s*3/i);
  assert.match(
    installer,
    /for\s+DriveCode\s*:=\s*Ord\('D'\)\s+to\s+Ord\('Z'\)/i,
  );
  assert.match(installer, /\{localappdata\}\\Programs\\AD Voice/i);
});

test('release packaging excludes development-only Python and AudioService artifacts', () => {
  assert.match(release, /python-runtime[^\r\n]*\/XD[^\r\n]*Doc/i);
  assert.match(
    release,
    /site-packages[^\r\n]*\/XD __pycache__[^\r\n]* \/XF \*\.pyc \*\.pyo __editable__\*/i,
  );
  assert.match(release, /installer\\prune_runtime\.py/i);
  assert.doesNotMatch(release, /robocopy "%AUDIO%\\build\\Release"/i);
  assert.match(
    release,
    /cmake\.exe --install[^\r\n]*--component AudioServiceRuntime/i,
  );
});

test('release checks the isolated bundled runtime before building Setup', () => {
  const smokeAt = release.indexOf(
    ' -B -I "%ROOT%installer\\verify_runtime.py"',
  );
  assert.ok(smokeAt > 0, 'Bundled Python imports and DSP must be exercised');
  assert.ok(smokeAt < release.lastIndexOf('"%ISCC%"'));
});

test('runtime verification includes the Oracle provider and processing PC worker', () => {
  assert.match(
    runtimeVerifier,
    /"backend\.infrastructure\.oracle_ai_provider"/,
  );
  assert.match(runtimeVerifier, /"backend\.remote_worker"/);
  assert.doesNotMatch(runtimeVerifier, /gradio_client|kaggle\.api/);
});

test('runtime verification does not contaminate the staged payload with bytecode', () => {
  assert.match(runtimeVerifier, /sys\.dont_write_bytecode\s*=\s*True/);
  assert.match(runtimeVerifier, /PYTHONDONTWRITEBYTECODE[^\r\n]*["']1["']/);
  assert.match(
    release,
    /python\.exe" -B -I "%ROOT%installer\\verify_runtime\.py"/i,
  );
});

test('developer setup installs every external tool required by release', () => {
  assert.match(developerSetup, /Git\.Git/);
  assert.match(developerSetup, /JRSoftware\.InnoSetup/);
  assert.match(developerSetup, /require_command git\.exe/i);
  assert.match(findIscc, /Inno Setup 6/i);
  assert.match(findIscc, /ISCC\.exe/i);
});

test('release builds every executable installed by the AudioService runtime component', () => {
  assert.match(
    buildSteps,
    /release:[^\r\n]*--target AudioService NativeVoiceRelay/i,
  );
});

test('release removes a stale Setup before invoking the compiler', () => {
  const removeAt = release.indexOf('if exist "%SETUP%" del /q "%SETUP%"');
  const compileAt = release.lastIndexOf('"%ISCC%"');
  assert.ok(removeAt > 0 && removeAt < compileAt);
});

test("build entry points explicitly provision Electron's lazy binary download", () => {
  assert.match(buildSteps, /npm\("electron:install"\)/);
  for (const script of ['release.bat', 'installer.bat', 'start-multy.bat']) {
    const source = readFileSync(
      new URL(`../../${script}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /scripts\\build-steps\.mjs/, script);
  }
});

test('a terminated installer compiler cannot report a previous Setup as successful', () => {
  const compile = release.slice(release.lastIndexOf('"%ISCC%"')).split(/\r?\n/);
  assert.equal(compile[1], 'if not "%errorlevel%"=="0" goto :fail');
});

test('release locks the Electron fuses and signs every shipped binary last', () => {
  const stamp = release.indexOf('stamp-exe-icon.mjs');
  const harden = release.indexOf('harden-electron.mjs');
  const signApp = release.indexOf(
    'sign-release.bat" "%APP_DIR%\\AD Voice.exe"',
  );
  const installerBuild = release.indexOf('"%ISCC%"');
  const signSetup = release.indexOf('sign-release.bat" "%SETUP%"');
  assert.ok(
    stamp > 0 && harden > stamp,
    'fuses are flipped after the icon is stamped',
  );
  assert.ok(
    signApp > harden,
    'the executable is signed after every change to it',
  );
  assert.ok(
    release.includes('AudioService.exe', signApp),
    'AudioService is signed too',
  );
  assert.ok(
    signSetup > installerBuild,
    'the installer is signed once it exists',
  );
});

test('release signs the shipped NativeVoiceRelay with the other application binaries', () => {
  const signingCommand = release
    .split(/\r?\n/)
    .find((line) =>
      line.includes('sign-release.bat" "%APP_DIR%\\AD Voice.exe"'),
    );
  assert.ok(
    signingCommand?.includes(
      '"%RESOURCES%\\audio-service\\NativeVoiceRelay.exe"',
    ),
  );
});
