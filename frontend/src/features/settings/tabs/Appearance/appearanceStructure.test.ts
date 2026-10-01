import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "src/features/settings/tabs/Appearance");
const component = readFileSync(resolve(directory, "index.tsx"), "utf8");
const styles = readFileSync(resolve(directory, "appearance.css"), "utf8");

describe("appearance reference layout", () => {
  it("uses the complete reference composition without the removed transfer and footer controls", () => {
    expect(component).toContain('className="appearanceStack"');
    expect(component).toMatch(/className="[^"]*appearancePreferences[^"]*"/);
    expect(component).toMatch(/className="[^"]*appearanceThemes[^"]*"/);
    expect(component).not.toContain("transferCode");
    expect(component).not.toContain("appearanceFooter");
  });

  it("keeps the reference card geometry and four-column theme grid", () => {
    expect(styles).toMatch(/\.appearanceProfile\s*\{[^}]*height:\s*140px/s);
    expect(styles).toMatch(/\.appearancePreferences\s*\{[^}]*height:\s*158px/s);
    expect(styles).toMatch(/\.appearanceThemes\s*\{[^}]*height:\s*254px/s);
    expect(styles).toMatch(/\.themeGrid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  });

  it("shows each existing theme illustration in full instead of cropping it", () => {
    const themePickerStyles = readFileSync(resolve(process.cwd(), "src/theme/ui/ThemePicker/theme-picker.css"), "utf8");
    expect(themePickerStyles).toMatch(/\.themeOption img,[\s\S]*?width:\s*min\(100%,\s*137px\);[\s\S]*?height:\s*137px;[\s\S]*?max-height:\s*100%;[\s\S]*?object-fit:\s*contain;/);
    expect(themePickerStyles).not.toMatch(/\.themeOption img,[\s\S]*?object-fit:\s*cover;/);
  });

  it("uses the reference canvas landscape in the profile card", () => {
    const artworkPath = resolve(directory, "ProfileLandscape.tsx");
    expect(existsSync(artworkPath)).toBe(true);
    const profile = readFileSync(resolve(process.cwd(), "src/features/social/ProfileSettings.tsx"), "utf8");
    const artwork = readFileSync(artworkPath, "utf8");
    expect(profile).toContain("<ProfileLandscape />");
    expect(artwork).toContain("paintLandscape");
    expect(artwork).toContain("1129");
    expect(artwork).toContain("profileLandscape");
  });
});
