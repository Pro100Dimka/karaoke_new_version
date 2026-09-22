import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapGate } from "./BootstrapGate";

const mocks = vi.hoisted(() => ({
  python: { kind: "starting" },
  appReady: vi.fn(),
}));

vi.mock("./ServicesContext", () => ({
  useServices: () => ({ python: mocks.python, probe: vi.fn() })
}));
vi.mock("./AppContext", () => ({
  useApp: () => ({ preferences: { audio: {} } })
}));
vi.mock("../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../services/audioClient", () => ({
  audioClient: { setPreferredConfiguration: vi.fn() }
}));
vi.mock("../services/desktopClient", () => ({
  desktopClient: { appReady: mocks.appReady }
}));

describe("BootstrapGate", () => {
  beforeEach(() => {
    mocks.python.kind = "starting";
    mocks.appReady.mockClear();
  });

  it("keeps the renderer empty while the native startup loader is visible", () => {
    const { container } = render(<BootstrapGate><div>application</div></BootstrapGate>);
    expect(container).toBeEmptyDOMElement();
  });

  it("reveals Electron only after the ready application has painted", async () => {
    mocks.python.kind = "ready";
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.push(callback);
      return frames.length;
    });

    render(<BootstrapGate><div>application background</div></BootstrapGate>);

    expect(mocks.appReady).not.toHaveBeenCalled();
    await act(async () => frames.shift()?.(0));
    expect(mocks.appReady).not.toHaveBeenCalled();
    await act(async () => frames.shift()?.(16));
    expect(mocks.appReady).toHaveBeenCalledOnce();
  });
});
