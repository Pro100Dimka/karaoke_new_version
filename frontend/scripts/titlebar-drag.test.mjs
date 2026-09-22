import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/app/app.css", import.meta.url), "utf8");

test("the free title-bar area drags the window while its controls stay clickable", () => {
  assert.match(styles, /\.titleBarLeading\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(styles, /\.titleBarLeading button\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(styles, /\.titleBarControls\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
});
