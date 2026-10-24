import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(
  resolve("src/features/karaoke/console/console.css"),
  "utf8",
);
const component = readFileSync(
  resolve("src/features/karaoke/console/KaraokeConsole.tsx"),
  "utf8",
);
const frame = readFileSync(
  resolve("src/features/karaoke/console/ConsoleFrame.tsx"),
  "utf8",
);

it("preserves the compact console appearance without extra headings or scrollbars", () => {
  const section = readFileSync(resolve("src/features/karaoke/console/ConsoleSection.tsx"), "utf8");
  const presets = readFileSync(resolve("src/features/karaoke/console/EffectPresets.tsx"), "utf8");
  expect(section).not.toContain("title={title}");
  expect(section).not.toContain("icon={icon}");
  expect(presets).toContain("columns={4}");
  expect(css.match(/\.karaokeConsoleCard\.ad-card\s*\{([^}]*)\}/)?.[1]).not.toMatch(/overflow:\s*auto/);
});

it("keeps console content within its floating panel and adapts the real lower grid", () => {
  expect(css).toMatch(
    /\.karaokeConsolePanel\s*\{[^}]*container-type:\s*inline-size/s,
  );
  expect(css).toMatch(
    /\.consolePanels\s*\{[^}]*grid-template-columns:\s*minmax\(0,/s,
  );
  // 90vw of the window, in pixels; the drag limits use the console's measured height.
  expect(component).toMatch(/consoleWidthShare\s*=\s*0\.9;/);
  expect(frame).toContain("defaultSize: size");
  expect(frame).toContain("useMeasuredPanelSize(frameRef");
  expect(readFileSync(resolve("src/shared/ui/useFloatingPanel.ts"), "utf8")).toContain("new ResizeObserver");
  // The four panels keep their original row; small windows fold to two and then one.
  expect(css).toMatch(
    /@container\s*\(max-width:\s*46rem\)\s*\{\s*\.consolePanels\s*\{[^}]*grid-template-columns:\s*repeat\(2,/,
  );
  expect(css).toMatch(
    /@container\s*\(max-width:\s*30rem\)[\s\S]*\.consolePanels/,
  );
});
