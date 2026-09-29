import { expect, it } from "vitest";
import { mixerGain } from "./mixerLevel";

it("turns equal accompaniment knob steps into equal loudness steps", () => {
  const decibels = (gain: number) => 20 * Math.log10(gain);
  expect(mixerGain("melody", 1)).toBe(1);
  expect(mixerGain("melody", 0)).toBe(0);
  expect(decibels(mixerGain("melody", 0.5))).toBeCloseTo(-18.1, 1);
  expect(decibels(mixerGain("reference", 0.25))).toBeCloseTo(-36.1, 1);
});

it("keeps the backing track below the voices at full turn", () => {
  expect(20 * Math.log10(mixerGain("music", 1))).toBeCloseTo(-6.0, 1);
});

it("never changes how loud a voice knob sounds", () => {
  expect(mixerGain("mic", 0.68)).toBe(0.68);
  expect(mixerGain("remote", 0.5)).toBe(0.5);
  expect(mixerGain("master", 0.5)).toBe(0.5);
});
