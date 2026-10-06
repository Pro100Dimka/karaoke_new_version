import { expect, it } from "vitest";
import { BackdropQuality, backdropBudgets } from "./backdropQuality";

const frames = (quality: BackdropQuality, count: number, interval: number) => {
  for (let frame = 0; frame < count; frame++) quality.sample(interval);
};

it("starts conservatively and backs off sustained slow rendering on any machine", () => {
  const quality = new BackdropQuality();
  expect(quality.budget).toEqual(backdropBudgets[1]);
  frames(quality, 61, 34);
  expect(quality.budget).toEqual(backdropBudgets[1]);
  frames(quality, 61, 34);
  expect(quality.budget).toEqual(backdropBudgets[0]);
  frames(quality, 600, 34);
  expect(quality.budget).toEqual(backdropBudgets[0]);
});

it("restores full density only after sustained smooth rendering", () => {
  const quality = new BackdropQuality();
  frames(quality, 4 * 120, 1000 / 60);
  expect(quality.budget).toEqual(backdropBudgets[1]);
  frames(quality, 12 * 120, 1000 / 60);
  expect(quality.budget).toEqual(backdropBudgets[3]);
});

it("does not react to isolated hitches or a suspended window", () => {
  const quality = new BackdropQuality();
  frames(quality, 130, 1000 / 60);
  quality.sample(100);
  frames(quality, 120, 1000 / 60);
  expect(quality.budget).toEqual(backdropBudgets[1]);
  quality.sample(5000);
  frames(quality, 61, 34);
  expect(quality.budget).toEqual(backdropBudgets[1]);
  for (const value of [NaN, Infinity, 0, -1])
    expect(quality.sample(value)).toBe(false);
});

it("reduces fullscreen pixel work when a 30 Hz backdrop falls to 20 Hz", () => {
  const quality = new BackdropQuality(1000 / 30);
  const initial = quality.budget.resolutionScale;
  frames(quality, 82, 50);
  expect(quality.budget).toEqual(backdropBudgets[0]);
  expect(quality.budget.resolutionScale ** 2).toBeLessThan(initial ** 2);
});

it("never requests more secondary vertices than the runtime allocates", () => {
  expect(Math.max(...backdropBudgets.map(b => b.secondaryParticles))).toBeLessThanOrEqual(14000);
});

it("does not oscillate back into an expensive level after recovering from overload", () => {
  const quality = new BackdropQuality(1000 / 30);
  frames(quality, 82, 50);
  frames(quality, 1800, 1000 / 30);
  expect(quality.budget).toEqual(backdropBudgets[0]);
});
