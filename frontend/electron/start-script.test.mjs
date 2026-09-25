import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const start = readFileSync(new URL("../../start.bat", import.meta.url), "utf8");
const multi = readFileSync(new URL("../../start-multy.bat", import.meta.url), "utf8");
const multiLauncher = readFileSync(new URL("../scripts/launch-multi.mjs", import.meta.url), "utf8");
const identity = readFileSync(new URL("./RuntimeIdentity.ts", import.meta.url), "utf8");
const release = readFileSync(new URL("../../release.bat", import.meta.url), "utf8");
const electronTsconfig = readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8");
const developmentLauncher = readFileSync(new URL("../scripts/dev-electron.mjs", import.meta.url), "utf8");

test("development startup does not terminate the installed app audio service", () => {
  assert.doesNotMatch(start, /taskkill[^\r\n]*\/im\s+AudioService\.exe/i);
});

test("development and installed profiles share the already downloaded AI model store", () => {
  assert.match(identity, /AD_VOICE_MODELS/);
  assert.match(identity, /"AD Voice"[\s\S]{0,120}"backend-data"[\s\S]{0,120}"models"/);
});

test("two-instance launcher reuses the normal dev profile and isolates only the guest while sharing models", () => {
  assert.match(multiLauncher, /AD Voice Dev/);
  assert.match(multiLauncher, /AD Voice Multi 2/);
  assert.match(multiLauncher, /AD_VOICE_PORT:\s*"0"/);
  assert.doesNotMatch(multiLauncher, /\b(?:8767|8772)\b/);
  assert.match(multiLauncher, /ADVoice\.AudioService\.Dev\.v1/);
  assert.match(multiLauncher, /ADVoice\.AudioService\.Multi2\.v1/);
  assert.match(multi, /AD_VOICE_MODELS/);
  assert.match(multiLauncher, /delete env\.AD_VOICE_DATA/);
});

test("release leaves only the Windows installer and no ISO media", () => {
  assert.doesNotMatch(release, /create_release_iso|pycdlib|AD-Voice-Setup\.iso/i);
  assert.match(release, /Only installer kept|Keeping only/i);
});

test("Electron uses the modern Node 16 module resolver", () => {
  const config = JSON.parse(electronTsconfig);
  assert.equal(config.compilerOptions.moduleResolution, "Node16");
  assert.equal(config.compilerOptions.module, "Node16");
});

test("development launcher closes both Electron and Vite on every termination signal", () => {
  assert.match(developmentLauncher, /let electron/);
  assert.match(developmentLauncher, /killTree\(electron\)/);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.match(developmentLauncher, new RegExp(`process\\.once\\("${signal}"`));
  }
});
