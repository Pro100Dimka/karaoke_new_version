import { act, render } from "@testing-library/react";
import { QuantumBackground, type QuantumBackgroundProps } from "@neo-ui-kit/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { microphoneLevel } from "../../services/inputLevel";
import { backdropSpectrum, voiceLevel } from "../../app/backdrop/backdropSpectrum";
import { LibraryBackdrop } from "./background";
import { publishSpectrum } from "../../app/backdrop/spectrumEvents";
import { toSpectrumFrame } from "../../app/backdrop/useSpectrumFeed";

vi.mock("@neo-ui-kit/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@neo-ui-kit/react")>(),
  QuantumBackground: vi.fn((_props: QuantumBackgroundProps) => null),
  quantumBackgroundFullscreenFieldSize: 1.1,
}));
vi.mock("../../services/inputLevel", () => ({ microphoneLevel: vi.fn(async () => 0) }));


const lastSpectrum = () => vi.mocked(QuantumBackground).mock.lastCall?.[0].spectrum;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(microphoneLevel).mockResolvedValue(0);
});

describe("backdrop spectrum", () => {
  it("gates room noise and maps a voice onto the spectrum's −60…0 dB scale", () => {
    expect(voiceLevel(0)).toBe(0);
    expect(voiceLevel(10 ** (-45 / 20))).toBe(0); // a quiet room
    expect(voiceLevel(10 ** (-15 / 20))).toBeCloseTo((45 / 60 - 0.35) / 0.65, 5); // singing
    expect(voiceLevel(1)).toBe(1);
  });

  it("folds the voice into the vocal range without doubling a monitored voice", () => {
    const silent = Array(18).fill(0);
    expect(backdropSpectrum(silent, 0)).toBeUndefined();
    const sung = backdropSpectrum(silent, 0.8)!;
    const peak = sung.indexOf(Math.max(...sung));
    // 40 Hz…12 kHz in 18 log steps: the voice peaks around 600 Hz (band 8), not in the sub-bass or air.
    expect(peak).toBeGreaterThanOrEqual(7);
    expect(peak).toBeLessThanOrEqual(9);
    expect(sung[0]).toBeLessThan(sung[peak]! / 3);
    const radio = Array.from({ length: 18 }, (_, band) => (band < 4 ? 0.9 : 0.3));
    const both = backdropSpectrum(radio, 0.8)!;
    both.forEach((level, band) => expect(level).toBe(Math.max(radio[band]!, sung[band]!)));
  });
});

describe("LibraryBackdrop", () => {
  it("drives the scene from the radio's output spectrum and rests in silence", async () => {
    vi.useFakeTimers();
    render(<LibraryBackdrop />);
    await flush();
    expect(lastSpectrum()).toBeUndefined();
    act(() => publishSpectrum(toSpectrumFrame(Array.from({ length: 18 }, () => 0.6))));
    expect(lastSpectrum()).toHaveLength(18);
    expect(lastSpectrum()![0]).toBeCloseTo(0.6);
    act(() => publishSpectrum(toSpectrumFrame(Array(18).fill(0))));
    expect(lastSpectrum()).toBeUndefined();
  });

  it("moves with the singer's microphone even while the speakers are silent", async () => {
    vi.useFakeTimers();
    vi.mocked(microphoneLevel).mockResolvedValue(10 ** (-12 / 20));
    render(<LibraryBackdrop />);
    await flush();
    expect(Math.max(...lastSpectrum()!)).toBeGreaterThan(0.5);
    vi.mocked(microphoneLevel).mockResolvedValue(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(lastSpectrum()).toBeUndefined();
  });
});
