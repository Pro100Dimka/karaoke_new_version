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
  restore: vi.fn(),
  sound: vi.fn(),
  room: null as null | { code: string },
  pythonKind: "ready",
}));
vi.mock("../../app/AppContext", () => ({
  useRoomRuntime: () => mocks.runtime,
  useRoomSession: () => ({ restore: mocks.restore }),
  useApp: () => ({ room: mocks.room, preferences: { audio: { backend: "ASIO" }, displayName: "Singer" } }),
}));
vi.mock("../../app/ServicesContext", () => ({
  useServices: () => ({ python: { kind: mocks.pythonKind } }),
}));
vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => mocks.notify,
  playNotificationSound: mocks.sound,
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
  expect(mocks.restore).toHaveBeenCalledWith("Singer");
  const adapter = mocks.runtime.attach.mock.calls[0]?.[0];

  act(() => adapter.curtain(true));
  expect(view.container.querySelector(".roomSceneCurtain")).not.toBeNull();
  act(() => adapter.curtain(false));
  adapter.navigate("song");
  adapter.notify("roomClosed", "warning");
  expect(mocks.navigate).toHaveBeenCalledWith("/karaoke/song", {
    state: { mode: "RoomPrepared" },
  });
  expect(mocks.notify).toHaveBeenCalledWith("roomClosed", "warning", { silent: false });
  view.unmount();
  expect(mocks.runtime.detach).toHaveBeenCalledOnce();
});

it("sounds entering a room once and preserves participant join/leave sounds without a second toast sound", () => {
  mocks.room = { code: "NEW" };
  const view = render(<RoomSync />);
  expect(mocks.sound).toHaveBeenCalledExactlyOnceWith("success");
  view.rerender(<RoomSync />);
  expect(mocks.sound).toHaveBeenCalledOnce();
  const adapter = mocks.runtime.attach.mock.calls[0]?.[0];
  adapter.notify("participantJoined", "info", { name: "Singer" });
  expect(mocks.notify).toHaveBeenLastCalledWith("participantJoined", "info", { silent: true });
  view.unmount();
  mocks.room = null;
});
