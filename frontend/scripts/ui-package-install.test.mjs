import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const vite = readFileSync(
  new URL("../vite.config.ts", import.meta.url),
  "utf8",
);

test("a clean frontend install uses an immutable UI release without patching node_modules", () => {
  const url = manifest.dependencies["@neo-ui-kit/react"];
  const match = url.match(
    /^https:\/\/github\.com\/Pro100Dimka\/adui\/releases\/download\/v(\d+\.\d+\.\d+)\/ad-voice-ui-\1\.tgz$/,
  );
  assert.ok(match, "UI dependency must name a versioned release asset");
  assert.equal(lock.packages[""].dependencies["@neo-ui-kit/react"], url);
  assert.equal(
    lock.packages["node_modules/@neo-ui-kit/react"].version,
    match[1],
  );
  assert.equal(lock.packages["node_modules/@neo-ui-kit/react"].resolved, url);
  assert.match(
    lock.packages["node_modules/@neo-ui-kit/react"].integrity,
    /^sha512-/,
  );
  assert.doesNotMatch(manifest.scripts.postinstall ?? "", /patch-ui-motion/);
  assert.doesNotMatch(vite, /patchUiMotion|patch-ui-motion/);
});

test("npm ci also provisions the Electron executable", () => {
  assert.equal(manifest.scripts.postinstall, "npm run electron:install");
});
