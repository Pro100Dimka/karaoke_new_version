import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomSync } from "./RoomSync";

const mocks = vi.hoisted(() => ({
  runtime: {
    attach: vi.fn(), detach: vi.fn(),
    setPythonReady: vi.fn(), setPersistedBackend: vi.fn(),
  },
  navigate: vi.fn(),
  notify: vi.fn(),
  pythonKind: "ready",
}));
vi.mock("../../app/AppContext", () => ({
  useRoomRuntime: () => mocks.runtime,
  useApp: () => ({ preferences: { audio: { backend: "ASIO" } } }),
}));
vi.mock("../../app/ServicesContext", () => ({
  useServices: () => ({ python: { kind: mocks.pythonKind } }),
}));
vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => mocks.notify,
}));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: "/library" }),
}));
afterEach(() => vi.clearAllMocks());

it("adapts application commands to navigation, notice, and curtain rendering", () => {
  const view = render(<RoomSync />);
  expect(mocks.runtime.attach).toHaveBeenCalledOnce();
  expect(mocks.runtime.setPythonReady).toHaveBeenCalledWith(true);
  expect(mocks.runtime.setPersistedBackend).toHaveBeenCalledWith("ASIO");
  const adapter = mocks.runtime.attach.mock.calls[0]?.[0];

  act(() => adapter.curtain(true));
  expect(view.container.querySelector(".roomSceneCurtain")).not.toBeNull();
  act(() => adapter.curtain(false));
  adapter.navigate("song");
  adapter.notify("roomClosed", "warning");
  expect(mocks.navigate).toHaveBeenCalledWith("/karaoke/song", {
    state: { mode: "RoomPrepared" },
  });
  expect(mocks.notify).toHaveBeenCalledWith("roomClosed", "warning");
  view.unmount();
  expect(mocks.runtime.detach).toHaveBeenCalledOnce();
});
