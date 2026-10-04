import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(resolve("src/features/karaoke/console/console.css"), "utf8");
const component = readFileSync(resolve("src/features/karaoke/console/KaraokeConsole.tsx"), "utf8");

it("keeps console content within its floating panel and adapts the real lower grid", () => {
  expect(css).toMatch(/\.karaokeConsolePanel\s*\{[^}]*container-type:\s*inline-size/s);
  expect(css).toMatch(/\.consolePanels\s*\{[^}]*grid-template-columns:\s*minmax\(0,/s);
  expect(component).toMatch(/consolePanelSize\s*=\s*\{\s*width:\s*1200,\s*height:\s*320\s*\}/);
  expect(component).toContain("defaultSize: consolePanelSize");
  // The four panels stay in one row until the console gets narrow, then fold to two and to one.
  expect(css).toMatch(/@container\s*\(max-width:\s*46rem\)\s*\{\s*\.consolePanels\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
  expect(css).toMatch(/@container\s*\(max-width:\s*30rem\)[\s\S]*\.consolePanels/);
});
