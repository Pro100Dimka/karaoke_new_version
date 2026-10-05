import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(resolve("src/features/karaoke/console/console.css"), "utf8");
const component = readFileSync(resolve("src/features/karaoke/console/KaraokeConsole.tsx"), "utf8");

it("keeps console content within its floating panel and adapts the real lower grid", () => {
  expect(css).toMatch(/\.karaokeConsolePanel\s*\{[^}]*container-type:\s*inline-size/s);
  expect(css).toMatch(/\.consolePanels\s*\{[^}]*grid-template-columns:\s*minmax\(0,/s);
  // 90vw of the window, in pixels, 320 high.
  expect(component).toMatch(/consoleWidthShare\s*=\s*0\.9;/);
  expect(component).toMatch(/consolePanelSize\s*=\s*useMemo\(\s*\(\)\s*=>\s*\(\{\s*width:\s*consoleWidth,\s*height:\s*consoleHeight\s*\}\)/);
  expect(component).toMatch(/consoleHeight\s*=\s*320;/);
  expect(component).toContain("defaultSize: consolePanelSize");
  // The four panels stay in one row until the console gets narrow, then fold to two and to one.
  expect(css).toMatch(/@container\s*\(max-width:\s*46rem\)\s*\{\s*\.consolePanels\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
  expect(css).toMatch(/@container\s*\(max-width:\s*30rem\)[\s\S]*\.consolePanels/);
});
