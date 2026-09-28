// @vitest-environment node
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("settings feature structure", () => {
  it("keeps tab-specific implementation out of the settings root", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    expect(files).toEqual([
      "SettingsCard.tsx",
      "SettingsContent.tsx",
      "SettingsModal.tsx",
      "settings.css",
      "settingsStructure.test.ts",
    ]);
  });
});
