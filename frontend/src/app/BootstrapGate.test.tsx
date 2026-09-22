import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BootstrapGate } from "./BootstrapGate";

vi.mock("./ServicesContext", () => ({
  useServices: () => ({ python: { kind: "starting" }, probe: vi.fn() })
}));
vi.mock("./AppContext", () => ({
  useApp: () => ({ preferences: { audio: {} } })
}));
vi.mock("../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../services/audioClient", () => ({
  audioClient: { setPreferredConfiguration: vi.fn() }
}));
vi.mock("../services/desktopClient", () => ({
  desktopClient: { appReady: vi.fn() }
}));

describe("BootstrapGate", () => {
  it("keeps the renderer empty while the native startup loader is visible", () => {
    const { container } = render(<BootstrapGate><div>application</div></BootstrapGate>);
    expect(container).toBeEmptyDOMElement();
  });
});
