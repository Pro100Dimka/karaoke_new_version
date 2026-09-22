import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const splash = readFileSync(new URL("./splash.html", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("startup splash contains only a loader on a transparent page", () => {
  assert.match(splash, /background:\s*transparent/);
  assert.match(splash, /class="loader"/);
  assert.doesNotMatch(splash, /<image\b/i);
});

test("content policy permits recognized cover art and YouTube clips", () => {
  assert.match(index, /img-src[^;]*https:/);
  assert.match(index, /frame-src[^;]*youtube-nocookie\.com/);
});
