import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const splash = readFileSync(new URL("./splash.html", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

test("startup splash contains only the glowing theme icon on a transparent page", () => {
  assert.match(splash, /background:\s*transparent/);
  assert.match(splash, /<image\s+id="icon"/i);
  assert.match(splash, /animation:\s*glow/);
  assert.doesNotMatch(splash, /class="loader"/);
});

test("splash forces a transparent compositor surface before it is shown", () => {
  const source = readFileSync(new URL("./Splash.ts", import.meta.url), "utf8");
  assert.match(source, /transparent:\s*true/);
  assert.match(source, /backgroundColor:\s*"#00000000"/);
  assert.match(source, /setBackgroundColor\("#00000000"\)/);
  assert.match(source, /show:\s*false/);
  assert.match(source, /once\("did-finish-load"/);
  assert.doesNotMatch(source, /once\("ready-to-show"/);
});

test("content policy permits recognized cover art and only local downloaded clips", () => {
  assert.match(index, /img-src[^;]*https:/);
  assert.match(index, /media-src[^;]*http:\/\/127\.0\.0\.1:\*/);
  assert.match(index, /frame-src\s+'none'/);
});

test("packaged Electron launches its bundled backend and media tools", () => {
  assert.match(main, /app\.isPackaged/);
  assert.match(main, /python-runtime/);
  assert.match(main, /python-app/);
  assert.match(main, /process\.resourcesPath,[\s\S]{0,80}"tools"/);
});
