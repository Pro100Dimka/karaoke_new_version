import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const splash = readFileSync(new URL("./splash.html", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("startup splash contains only the glowing theme icon on a transparent page", () => {
  assert.match(splash, /background:\s*transparent/);
  assert.match(splash, /<image\s+id="icon"/i);
  assert.match(splash, /animation:\s*glow/);
  assert.doesNotMatch(splash, /class="loader"/);
});

test("splash window stays hidden until its transparent document is painted", () => {
  const source = readFileSync(new URL("./Splash.ts", import.meta.url), "utf8");
  assert.match(source, /transparent:\s*true/);
  assert.match(source, /backgroundColor:\s*"#00000000"/);
  assert.match(source, /show:\s*false/);
  assert.match(source, /once\("ready-to-show"/);
});

test("content policy permits recognized cover art and YouTube clips", () => {
  assert.match(index, /img-src[^;]*https:/);
  assert.match(index, /frame-src[^;]*youtube-nocookie\.com/);
});
