import { describe, expect, it } from "vitest";

/** Every source and stylesheet of the feature, as the bundler sees them. */
const sources = import.meta.glob(["./**/*.{ts,tsx,css}", "!./**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const profile = import.meta.glob("../social/ProfileSettings.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const read = (path: string) => sources[`./${path}`] ?? "";

describe("settings feature structure", () => {
  it("keeps tab-specific implementation out of the settings root", () => {
    const root = Object.keys(sources)
      .filter((path) => path.split("/").length === 2)
      .map((path) => path.slice(2))
      .sort();
    expect(root).toEqual(["index.tsx", "settings.css", "settingsForm.ts"]);
  });

  it("builds every screen from Neo UI instead of app-local widgets and icon sets", () => {
    for (const [path, text] of Object.entries(sources).filter(([path]) =>
      path.endsWith(".tsx"),
    )) {
      expect(text, path).not.toContain("lucide-react");
      expect(text, path).not.toContain("RenderFormikFields");
    }
  });

  it("sizes layouts by content and screen, not by fixed pixel geometry", () => {
    for (const [path, text] of Object.entries(sources).filter(([path]) =>
      path.endsWith(".css"),
    ))
      expect(text, path).not.toMatch(/\d+px/);
  });

  it("keeps the scenery: the window's planet, atmosphere, neon frame and signature", () => {
    const modal = read("index.tsx");
    for (const scene of [
      "<SettingsAtmosphere",
      "<Planet",
      "<AnimatedBorder",
      "<BrandMark",
    ])
      expect(modal).toContain(scene);
  });

  it("keeps each tab's own pictures", () => {
    expect(read("tabs/Ai/index.tsx")).toContain("<NeonWaves");
    const environment = read("tabs/Secrets/EnvironmentGroupCard.tsx");
    for (const scene of ["<NeonWaves", "<ServerArt", "<Spectrum"])
      expect(environment).toContain(scene);
    expect(read("tabs/Advanced/Storage/index.tsx")).toContain("<DatabaseArt");
    expect(read("tabs/Advanced/History/index.tsx")).toContain("<NeonWaves");
    expect(read("tabs/Advanced/About/index.tsx")).toContain("<Planet");
    expect(profile["../social/ProfileSettings.tsx"]).toContain("<Landscape");
  });
});
