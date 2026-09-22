import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapGate } from "./BootstrapGate";

let pythonState: { kind: string } = { kind: "starting" };
const appReady = vi.fn();

vi.mock("./ServicesContext", () => ({
  useServices: () => ({ python: pythonState, probe: vi.fn() })
}));
vi.mock("./AppContext", () => ({
  useApp: () => ({ preferences: { audio: {} } })
}));
vi.mock("../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../services/audioClient", () => ({
  audioClient: { setPreferredConfiguration: vi.fn() }
}));
vi.mock("../services/desktopClient", () => ({
  desktopClient: { appReady }
}));

describe("BootstrapGate", () => {
  beforeEach(() => {
    pythonState = { kind: "starting" };
    appReady.mockClear();
  });

  it("keeps the renderer empty while the native startup loader is visible", () => {
    const { container } = render(<BootstrapGate><div>application</div></BootstrapGate>);
    expect(container).toBeEmptyDOMElement();
  });

  it("reveals Electron only after the ready application has painted", async () => {
    pythonState = { kind: "ready" };
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.push(callback);
      return frames.length;
    });

    render(<BootstrapGate><div>application background</div></BootstrapGate>);

    expect(appReady).not.toHaveBeenCalled();
    await act(async () => frames.shift()?.(0));
    expect(appReady).not.toHaveBeenCalled();
    await act(async () => frames.shift()?.(16));
    expect(appReady).toHaveBeenCalledOnce();
  });
});
