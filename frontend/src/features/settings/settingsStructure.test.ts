import { describe, expect, it } from "vitest";

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
      "settings.css",
    ]);
  });
});
