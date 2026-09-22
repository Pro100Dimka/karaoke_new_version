import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const release = readFileSync(new URL("../../release.bat", import.meta.url), "utf8");

test("release produces a conventional offline Setup.exe and wraps it in an ISO", () => {
  assert.match(release, /npm\.cmd(?:"|\s)+run build/i);
  assert.match(release, /electron:compile/i);
  assert.match(release, /cmake\.exe --build/i);
  assert.match(release, /ISCC\.exe/i);
  assert.match(release, /AD-Voice-Setup\.exe/i);
  assert.match(release, /create_release_iso\.py/i);
  assert.match(release, /AD-Voice-Setup\.iso/i);
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

test("a repeated release builds the ISO under a temporary name before replacing the previous image", () => {
  assert.match(release, /ISO_TEMP/i);
  assert.match(release, /create_release_iso\.py[^\r\n]*%ISO_TEMP%/i);
  assert.match(release, /move \/y "%ISO_TEMP%" "%ISO%"/i);
  assert.match(release, /set "ISO=%ISO_TEMP%"/i);
});

test("a private release bundles the configured environment without printing its values", () => {
  assert.match(release, /if exist "%PYTHON%\\\.env"/i);
  assert.match(release, /copy \/y "%PYTHON%\\\.env" "%RESOURCES%\\python-app\\\.env"/i);
  assert.doesNotMatch(release, /type "%PYTHON%\\\.env"/i);
});
