import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RollFx, StageFx } from "./ShowLayers";
import type { ShowEngine } from "./showEngine";

const state = vi.hoisted(() => ({ limited: false, start: vi.fn(), stop: vi.fn() }));
vi.mock("../../../app/DecorationBudgetContext", () => ({ useDecorationBudget: () => state.limited }));
vi.mock("./stageFxRenderer", () => ({ StageFxRenderer: class { start = state.start; stop = state.stop; } }));
vi.mock("./rollFxRenderer", () => ({ RollFxRenderer: class { start = state.start; stop = state.stop; } }));

it("stops both expensive renderers and releases their canvases when the UI budget is exceeded", () => {
  const engine = {} as ShowEngine;
  const child = <main className="karaokePage"><StageFx engine={engine} /><RollFx engine={engine}
    view={{ notes: [], position: 0, span: 8, lead: 0.25, low: 48, high: 84 }} /></main>;
  const view = render(child);
  expect(state.start).toHaveBeenCalledTimes(2);
  expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
  state.limited = true;
  // New elements simulate a budget context update without replacing the engine.
  view.rerender(<main className="karaokePage"><StageFx engine={engine} /><RollFx engine={engine}
    view={{ notes: [], position: 0, span: 8, lead: 0.25, low: 48, high: 84 }} /></main>);
  expect(state.stop).toHaveBeenCalledTimes(2);
  expect(view.container.querySelectorAll("canvas")).toHaveLength(0);
  expect(state.start).toHaveBeenCalledTimes(2);
});
