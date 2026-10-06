import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RollFx, StageFx } from "./ShowLayers";
import type { ShowEngine } from "./showEngine";

const state = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("./stageFxRenderer", () => ({ StageFxRenderer: class { start = state.start; stop = state.stop; } }));
vi.mock("./rollFxRenderer", () => ({ RollFxRenderer: class { start = state.start; stop = state.stop; } }));

it("keeps both karaoke effect renderers visible across stage updates", () => {
  const engine = {} as ShowEngine;
  const child = <main className="karaokePage"><StageFx engine={engine} /><RollFx engine={engine}
    view={{ notes: [], position: 0, span: 8, lead: 0.25, low: 48, high: 84 }} /></main>;
  const view = render(child);
  expect(state.start).toHaveBeenCalledTimes(2);
  expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
  view.rerender(<main className="karaokePage"><StageFx engine={engine} /><RollFx engine={engine}
    view={{ notes: [], position: 0, span: 8, lead: 0.25, low: 48, high: 84 }} /></main>);
  expect(state.stop).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
  expect(state.start).toHaveBeenCalledTimes(2);
});
