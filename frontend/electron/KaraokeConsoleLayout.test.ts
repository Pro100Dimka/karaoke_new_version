import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(resolve("src/features/karaoke/console/console.css"), "utf8");

it("keeps console content within its floating panel and adapts the real lower grid", () => {
  expect(css).toMatch(/\.karaokeConsoleContent\s*\{[^}]*min-inline-size:\s*0/s);
  expect(css).toMatch(/\.karaokeConsolePanel\s*\{[^}]*container-type:\s*inline-size/s);
  expect(css).toMatch(/@container\s*\(max-width:\s*1150px\)[\s\S]*\.consolePanels\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
});
