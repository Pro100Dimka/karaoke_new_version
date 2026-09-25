import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("rotary artwork follows every application theme", () => {
  const css = readFileSync(new URL("../src/theme/ui/RotaryKnob/rotary-knob.css", import.meta.url), "utf8");
  const fragments = [
    ...["dark", "light", "green", "violet"].map(theme => `:root[data-theme="${theme}"] .ui-rotary-knob`),
    "filter: var(--rotary-art-filter)", "var(--rotary-accent)",
  ];
  for (const fragment of fragments) assert.ok(css.includes(fragment), fragment);
});
