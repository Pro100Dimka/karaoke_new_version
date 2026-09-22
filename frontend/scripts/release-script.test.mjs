import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const release = readFileSync(new URL("../../release.bat", import.meta.url), "utf8");

test("release builds every service and produces an ISO without private env files", () => {
  assert.match(release, /npm\.cmd(?:"|\s)+run build/i);
  assert.match(release, /electron:compile/i);
  assert.match(release, /cmake\.exe --build/i);
  assert.match(release, /create_release_iso\.py/i);
  assert.match(release, /AD-Voice-Setup\.iso/i);
  assert.match(release, /\.env/i);
  assert.match(release, /\/XF[^\r\n]*\.env/i);
});
