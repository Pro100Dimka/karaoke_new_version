import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const start = readFileSync(new URL("../../start.bat", import.meta.url), "utf8");
const multi = readFileSync(new URL("../../start-multy.bat", import.meta.url), "utf8");
const multiLauncher = readFileSync(new URL("../scripts/launch-multi.mjs", import.meta.url), "utf8");
const identity = readFileSync(new URL("./RuntimeIdentity.ts", import.meta.url), "utf8");

test("development startup does not terminate the installed app audio service", () => {
  assert.doesNotMatch(start, /taskkill[^\r\n]*\/im\s+AudioService\.exe/i);
});

test("development and installed profiles share the already downloaded AI model store", () => {
  assert.match(identity, /AD_VOICE_MODELS/);
  assert.match(identity, /"AD Voice"[\s\S]{0,120}"backend-data"[\s\S]{0,120}"models"/);
});

test("two-instance launcher isolates profiles, services and data while sharing only models", () => {
  assert.match(multiLauncher, /AD Voice Multi 1/);
  assert.match(multiLauncher, /AD Voice Multi 2/);
  assert.match(multiLauncher, /port:\s*"8771"/);
  assert.match(multiLauncher, /port:\s*"8772"/);
  assert.match(multiLauncher, /ADVoice\.AudioService\.Multi1\.v1/);
  assert.match(multiLauncher, /ADVoice\.AudioService\.Multi2\.v1/);
  assert.match(multi, /AD_VOICE_MODELS/);
  assert.match(multiLauncher, /delete env\.AD_VOICE_DATA/);
});
