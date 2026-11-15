import { expect, it } from 'vitest';
import {
  mixerGain,
  volumeFromKnob,
  volumeToKnob,
} from '../shared/utils/mixerLevel';

it('turns equal visible accompaniment steps into equal decibel changes without changing saved gains', () => {
  const decibels = (gain: number) => 20 * Math.log10(gain);
  expect(mixerGain('melody', 1)).toBe(1);
  expect(mixerGain('melody', 0)).toBe(0);
  expect(decibels(volumeFromKnob(0.8))).toBeCloseTo(-12, 8);
  expect(decibels(volumeFromKnob(0.6))).toBeCloseTo(-24, 8);
  expect(decibels(volumeFromKnob(0.5))).toBeCloseTo(-30, 8);
  expect(decibels(volumeFromKnob(0.25))).toBeCloseTo(-45, 8);
  const displayed = volumeToKnob(mixerGain('music', 0.7));
  expect(displayed).toBeCloseTo(0.84509804, 8);
  expect(mixerGain('music', Math.cbrt(volumeFromKnob(displayed)))).toBeCloseTo(
    0.343,
    12,
  );
});

it('never changes how loud a voice knob sounds', () => {
  expect(mixerGain('mic', 0.68)).toBe(0.68);
  expect(mixerGain('remote', 0.5)).toBe(0.5);
  expect(mixerGain('master', 0.5)).toBe(0.5);
});

it('allows microphone makeup gain above unity while retaining exact mute and other channel ranges', () => {
  expect(mixerGain('mic', 4)).toBe(4);
  expect(mixerGain('mic', 2)).toBe(2);
  expect(mixerGain('mic', 0)).toBe(0);
  expect(mixerGain('mic', 5)).toBe(4);
  expect(mixerGain('music', 2)).toBe(1);
  expect(mixerGain('remote', 2)).toBe(1);
  expect(volumeFromKnob(0)).toBe(0);
  expect(volumeToKnob(0)).toBe(0);
  expect(volumeFromKnob(1)).toBe(1);
  expect(volumeFromKnob(2)).toBe(1);
});

it('shows the full master range as 0 to 100 percent while retaining the existing boost', () => {
  expect(mixerGain('master', 1.25)).toBe(1.25);
  expect(mixerGain('master', 1.5)).toBe(1.5);
  expect(mixerGain('master', 2)).toBe(1.5);
  expect(mixerGain('master', 0)).toBe(0);
  expect(volumeFromKnob(1, 1.5)).toBe(1.5);
  expect(volumeToKnob(1.5, 1.5)).toBe(1);
  expect(volumeToKnob(1, 1.5)).toBeCloseTo(0.9413029136, 8);
  expect(volumeFromKnob(volumeToKnob(1, 1.5), 1.5)).toBeCloseTo(1, 12);
  expect(volumeFromKnob(0, 1.5)).toBe(0);
});
