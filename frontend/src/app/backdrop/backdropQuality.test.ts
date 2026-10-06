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
