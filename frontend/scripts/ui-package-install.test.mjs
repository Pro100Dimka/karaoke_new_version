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

test("a clean frontend install uses an exact npm UI release without patching node_modules", () => {
  const version = manifest.dependencies["@neo-ui-kit/react"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "UI dependency must pin an exact release");
  assert.equal(lock.packages[""].dependencies["@neo-ui-kit/react"], version);
  assert.equal(
    lock.packages["node_modules/@neo-ui-kit/react"].version,
    version,
  );
  assert.equal(lock.packages["node_modules/@neo-ui-kit/react"].resolved,
    `https://registry.npmjs.org/@neo-ui-kit/react/-/react-${version}.tgz`);
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
