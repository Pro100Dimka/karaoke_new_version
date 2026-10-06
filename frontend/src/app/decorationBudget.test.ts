import { expect, it } from "vitest";
import { DecorationBudget } from "./decorationBudget";

it("keeps decoration on while the UI maintains 60 fps", () => {
  const budget = new DecorationBudget();
  for (let frame = 0; frame < 1000; frame++) expect(budget.sample(1000 / 60)).toBe(false);
});
it("releases the decoration budget after sustained 20 fps rendering", () => {
  const budget = new DecorationBudget();
  for (let frame = 0; frame < 79; frame++) expect(budget.sample(50)).toBe(false);
  expect(budget.sample(50)).toBe(true);
  for (let frame = 0; frame < 100; frame++) expect(budget.sample(16.7)).toBe(true);
});
it("does not treat background throttling or one isolated stall as sustained overload", () => {
  const budget = new DecorationBudget();
  for (let frame = 0; frame < 100; frame++) expect(budget.sample(1000)).toBe(false);
  for (let frame = 0; frame < 500; frame++) expect(budget.sample(frame === 200 ? 200 : 16.7)).toBe(false);
});
