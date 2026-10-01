import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("remaining settings reference layouts", () => {
  it("uses the reference two-card audio composition with the existing rotary knobs", () => {
    const audio = read("src/features/settings/tabs/Audio/index.tsx");
    const tests = read("src/features/settings/tabs/Audio/AudioTests.tsx");
    const styles = read("src/features/settings/tabs/Audio/audio.css");

    expect(audio).toContain('className="audioSettings audioStack"');
    expect(audio).toContain('className="audioDevicesCard"');
    expect(tests).toContain('className="audioMonitoringCard"');
    expect(tests.match(/<RotaryKnob/g)).toHaveLength(2);
    expect(styles).toMatch(/\.audioDevicesCard\s*\{[^}]*height:\s*306px/s);
    expect(styles).toMatch(/\.audioMonitoringCard\s*\{[^}]*height:\s*423px/s);
  });

  it("uses the full-height AI shell and three-column model row", () => {
    const component = read("src/features/settings/tabs/Ai/index.tsx");
    const styles = read("src/features/settings/tabs/Ai/ai.css");

    expect(component).toContain("<SettingsCard");
    expect(component).toContain('className="aiShellCard"');
    expect(component).toContain('className="aiModels"');
    expect(styles).toMatch(/\.aiShellCard\s*\{[^}]*height:\s*839px/s);
    expect(styles).toMatch(/\.aiModels\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  });

  it("lays ENV cards out as top pair followed by full-width cards", () => {
    const component = read("src/features/settings/tabs/Secrets/index.tsx");
    const styles = read("src/features/settings/tabs/Secrets/secrets.css");

    expect(component).toContain('className="environmentTopRow"');
    expect(styles).toMatch(/\.environmentTopRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.07fr\)\s+minmax\(0,\s*1fr\)/s);
    expect(styles).toMatch(/\.environmentGroupCard\[data-group="recognition"\]\s*\{[^}]*height:\s*176px/s);
    expect(styles).toMatch(/\.environmentGroupCard\[data-group="deployment"\]\s*\{[^}]*height:\s*194px/s);
  });
});
