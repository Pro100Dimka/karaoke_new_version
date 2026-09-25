import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const release = readFileSync(new URL("../../release.bat", import.meta.url), "utf8");
const installer = readFileSync(new URL("../../installer/ad-voice.iss", import.meta.url), "utf8");

test("public release ignores developer secrets and private bundling requires an explicit file", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-release-env-"));
  try {
    mkdirSync(join(root, "python"));
    mkdirSync(join(root, "local-secrets", "env"), { recursive: true });
    const example = join(root, "python", ".env.example");
    const privateFile = join(root, "local-secrets", "env", "python.env");
    writeFileSync(example, "");
    writeFileSync(privateFile, "TEST_KEY=not-a-real-key\n");
    const selector = join(root, "select.bat");
    writeFileSync(selector, release.slice(0, release.indexOf('cd /d "%ROOT%"')) + '\necho SELECTED:%RELEASE_ENV%\nexit /b 0\n:fail\nexit /b 1\n');
    const select = (args = []) => spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", selector, ...args], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, AD_VOICE_ENV_FILE: privateFile },
    });
    const selected = result => result.stdout.split(/\r?\n/).find(line => line.startsWith("SELECTED:"))?.slice(9);
    const publicBuild = select();
    assert.equal(publicBuild.status, 0);
    assert.equal(selected(publicBuild), example);
    const privateBuild = select(["--private-env", privateFile]);
    assert.equal(privateBuild.status, 0);
    assert.equal(selected(privateBuild), privateFile);
    assert.equal(select(["--private-env", join(root, "absent.env")]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release uses an isolated native build and installs its compiler runtime", () => {
  assert.doesNotMatch(release, /-B "%AUDIO%\\build"/i);
  assert.match(release, /cmake\.exe --install[^\r\n]*--component AudioServiceRuntime/i);
  assert.doesNotMatch(release, /copy \/y "%PYTHON_BASE%\\(?:vcruntime|msvcp)/i);
});

test("developer setup retains native regression tests in its shared build directory", () => {
  const setup = readFileSync(new URL("../../installer.bat", import.meta.url), "utf8");
  assert.ok(!setup.includes("-DAUDIOSERVICE_BUILD_TESTS=OFF"));
});

test("release produces a conventional offline Setup.exe without ISO media", () => {
  assert.match(release, /npm\.cmd(?:"|\s)+run build/i);
  assert.match(release, /electron:compile/i);
  assert.match(release, /cmake\.exe --build/i);
  assert.match(release, /ISCC\.exe/i);
  assert.match(release, /AD-Voice-Setup\.exe/i);
  assert.doesNotMatch(release, /create_release_iso\.py/i);
  assert.doesNotMatch(release, /AD-Voice-Setup\.iso/i);
  assert.match(release, /\.env/i);
  assert.match(release, /\/XF[^\r\n]*\.env/i);
});

test("the installed app bundles Electron, Python, AudioService and FFmpeg", () => {
  assert.match(release, /node_modules\\electron\\dist/i);
  assert.match(release, /python-runtime/i);
  assert.match(release, /site-packages/i);
  assert.match(release, /audio-service/i);
  assert.match(release, /ffmpeg\.exe/i);
});

test("release cleanup leaves only the finished installer", () => {
  assert.match(release, /Keeping only the finished installer/i);
  assert.match(release, /for \/d %%D in \("%RELEASE%\\\*"\)[^\r\n]*rmdir \/s \/q/i);
  assert.match(release, /if \/i not "%%~nxF"=="AD-Voice-Setup\.exe" del \/q/i);
});

test("a private release bundles the configured environment without printing its values", () => {
  assert.ok(release.includes('--private-env'));
  assert.ok(release.includes('copy /y "%RELEASE_ENV%" "%RESOURCES%\\python-app\\.env"'));
  assert.doesNotMatch(release, /type "%RELEASE_ENV%"/i);
});

test("the branded icon is embedded into the installed executable before Setup is built", () => {
  assert.match(release, /stamp-exe-icon\.mjs/i);
  const iconCreatedAt = release.search(/ad-voice\.ico/i);
  const executableStampedAt = release.search(/stamp-exe-icon\.mjs/i);
  const setupBuiltAt = release.lastIndexOf('"%ISCC%"');
  assert.ok(iconCreatedAt >= 0 && executableStampedAt > iconCreatedAt);
  assert.ok(setupBuiltAt > executableStampedAt);
});

test("the installer defaults to the first fixed drive outside C and falls back to the user profile", () => {
  assert.match(installer, /DefaultDirName=\{code:GetDefaultDirName\}/i);
  assert.match(installer, /GetDriveTypeW@kernel32\.dll/i);
  assert.match(installer, /DRIVE_FIXED\s*=\s*3/i);
  assert.match(installer, /for\s+DriveCode\s*:=\s*Ord\('D'\)\s+to\s+Ord\('Z'\)/i);
  assert.match(installer, /\{localappdata\}\\Programs\\AD Voice/i);
});

test("release packaging excludes development-only Python and AudioService artifacts", () => {
  assert.match(release, /python-runtime[^\r\n]*\/XD[^\r\n]*Doc/i);
  assert.match(release, /site-packages[^\r\n]*\/XD __pycache__ \/XF \*\.pyc \*\.pyo __editable__\*/i);
  assert.doesNotMatch(release, /robocopy "%AUDIO%\\build\\Release"/i);
  assert.match(release, /cmake\.exe --install[^\r\n]*--component AudioServiceRuntime/i);
});

test("release checks the isolated bundled runtime before building Setup", () => {
  const smokeAt = release.indexOf(' -I "%ROOT%installer\\verify_runtime.py"');
  assert.ok(smokeAt > 0, "Bundled Python imports and DSP must be exercised");
  assert.ok(smokeAt < release.lastIndexOf('"%ISCC%"'));
});

test("build entry points explicitly provision Electron's lazy binary download", () => {
  for (const script of ["release.bat", "installer.bat", "start-multy.bat"]) {
    const source = readFileSync(new URL(`../../${script}`, import.meta.url), "utf8");
    assert.match(source, /call npm(?:\.cmd)? run electron:install/, script);
  }
});

test("a terminated installer compiler cannot report a previous Setup as successful", () => {
  const compile = release.slice(release.lastIndexOf('"%ISCC%"')).split(/\r?\n/);
  assert.equal(compile[1], 'if not "%errorlevel%"=="0" goto :fail');
});
