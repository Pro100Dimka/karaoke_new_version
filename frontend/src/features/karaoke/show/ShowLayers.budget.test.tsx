import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { RollFx, StageFx } from "./ShowLayers";
import type { ShowEngine } from "./showEngine";

const state = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), canvases: new Set<HTMLCanvasElement>() }));
vi.mock("./stageFxRenderer", () => ({ StageFxRenderer: class {
  constructor(canvas: HTMLCanvasElement) {
    if (state.canvases.has(canvas)) throw new DOMException("Canvas was already transferred", "InvalidStateError");
    state.canvases.add(canvas);
  }
  start = state.start;
  stop = state.stop;
} }));
vi.mock("./rollFxRenderer", () => ({ RollFxRenderer: class { start = state.start; stop = state.stop; } }));

beforeEach(() => { vi.clearAllMocks(); state.canvases.clear(); });

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

it("gives each StrictMode renderer lifecycle its own transferable canvas", () => {
  const engine = {} as ShowEngine;
  const view = render(<StrictMode><main className="karaokePage"><StageFx engine={engine} /></main></StrictMode>);

  expect(state.start).toHaveBeenCalledTimes(2);
  expect(state.stop).toHaveBeenCalledTimes(1);
  expect(state.canvases.size).toBe(2);
  expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  view.unmount();
  expect(state.stop).toHaveBeenCalledTimes(2);
});
