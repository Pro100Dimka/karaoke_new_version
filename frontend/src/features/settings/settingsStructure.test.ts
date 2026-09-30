import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve("src/features/settings", path), "utf8");

describe("settings feature structure", () => {
  it("keeps tab-specific implementation out of the settings root", () => {
    // The files directly in this folder, as the bundler sees them (tabs live in their own folders);
    // the bundler leaves out this test file itself.
    const files = Object.keys(import.meta.glob("./*", { query: "?url" }))
      .map((path) => path.slice(2))
      .sort();

    expect(files).toEqual([
      "SettingsCard.tsx",
      "SettingsContent.tsx",
      "SettingsModal.tsx",
      "SettingsNeonFrame.tsx",
      "settings.css",
    ]);
  });

  it("fits the complete advanced layout without bottom padding or visible scroll rails", () => {
    const settingsCss = source("settings.css");
    const settingsModalSource = source("SettingsModal.tsx");
    const advancedCss = source("tabs/Advanced/advanced.css");
    const historySource = source("tabs/Advanced/History/index.tsx");

    expect(settingsCss).toMatch(/\.settingsBody\s*\{[^}]*padding:\s*0 10px 0;[^}]*overflow:\s*hidden;/s);
    expect(settingsModalSource).not.toContain("SettingsScrollRail");
    expect(advancedCss).not.toContain(".historyScrollRail");
    expect(historySource).not.toContain("historyScrollRail");
  });
});
