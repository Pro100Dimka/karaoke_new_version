import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buttonStyles = readFileSync("src/theme/ui/Button/button.css", "utf8");

describe("Button lighting palette", () => {
  it("keeps the contained-button light pulse inside the active primary palette", () => {
    const containedEffects = buttonStyles.match(
      /\.ui-button\[data-variant="contained"\]::before\s*\{[\s\S]*?\n\s*\}/,
    )?.[0];
    const movingHighlight = buttonStyles.match(
      /\.ui-button\[data-variant="contained"\]::after\s*\{[\s\S]*?\n\s*\}/,
    )?.[0];

    expect(containedEffects).toContain("var(--color-primary-hover)");
    expect(containedEffects).not.toMatch(/\bwhite\b/);
    expect(movingHighlight).toContain("var(--color-primary-hover)");
    expect(movingHighlight).not.toMatch(/\bwhite\b/);
  });
});
