import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("audio settings reference artwork", () => {
  it("keeps the original live microphone waveform instead of a decorative latency bar", () => {
    const audioTestsSource = read("src/features/settings/tabs/Audio/AudioTests.tsx");
    expect(audioTestsSource).toContain("LiveSignalWaveform");
    expect(audioTestsSource).not.toContain("AudioLatencyBar");
  });

  it("renders the three independent animated scenes from the reference", () => {
    const artworkPath = "src/features/settings/tabs/Audio/AudioArtwork.tsx";
    expect(existsSync(resolve(process.cwd(), artworkPath))).toBe(true);
    const audioTestsSource = read("src/features/settings/tabs/Audio/AudioTests.tsx");
    const artworkSource = read(artworkPath);
    expect(audioTestsSource).toContain('kind="latency"');
    expect(audioTestsSource).toContain('kind="levels"');
    expect(audioTestsSource).toContain('kind="monitor"');
    expect(audioTestsSource).toContain('<AudioArtwork kind="monitor" />');
    expect(audioTestsSource).not.toContain('<AudioArtwork kind="monitor" enabled={testingInput} />');
    expect(artworkSource).toContain("audioSpectrumColumn");
    expect(artworkSource).toContain("requestAnimationFrame");
  });
});
