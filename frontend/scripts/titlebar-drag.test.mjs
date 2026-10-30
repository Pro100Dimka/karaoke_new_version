import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(
  new URL("../src/app/app.css", import.meta.url),
  "utf8",
);

test("the free title-bar area drags the window while its controls stay clickable", () => {
  const titlebar = readFileSync(new URL("../src/app/TitleBar.tsx", import.meta.url), "utf8");
  // Pointer capture handles both true fullscreen and modal top layers, where a native drag region fails.
  assert.match(
    styles,
    /\.titleBarLeading\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(titlebar, /document\.addEventListener\("pointerdown", down, options\)/);
  assert.match(titlebar, /setPointerCapture/);
  assert.match(titlebar, /desktopClient\.dragWindow\("start"/);
  assert.match(titlebar, /target\.closest\("button, a, input, textarea, select, label,/);
  assert.match(
    styles,
    /\.titleBarLeading button\s*[,{][^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(
    styles,
    /\.titleBarControls\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
});
