import { store } from "../../providers/store";
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
vi.mock("../../providers/application", () => ({
  getRoomRuntime: () => mocks.runtime,
  roomSession: { restore: mocks.restore },
  useApp: () => ({ room: mocks.room, preferences: { audio: { backend: "ASIO" }, displayName: "Singer" } }),
}));

vi.mock("../../providers/notifications", () => ({
  useNotify: () => mocks.notify,
  playNotificationSound: mocks.sound,
}));

vi.mock("@neo-ui-kit/react", async original => ({
  ...await original<typeof import("@neo-ui-kit/react")>(),
  useRouter: () => ({ navigate: mocks.navigate, pathname: "/library" }),
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
  expect(store.prepareKaraoke).toHaveBeenCalledWith("song", "RoomPrepared");
  expect(mocks.navigate).toHaveBeenCalledWith("/karaoke/song");
  expect(mocks.notify).toHaveBeenCalledWith("Комната закрыта", "warning", { silent: false });
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
  expect(mocks.notify).toHaveBeenLastCalledWith("Singer присоединился", "info", { silent: true });
  view.unmount();
  mocks.room = null;
});

vi.mock("../../providers/store", () => ({ store: {
  prepareKaraoke: vi.fn(),
  get online() { return { room: mocks.room }; },
  get application() { return { services: { python: { kind: mocks.pythonKind } } }; },
  get preferences() { return { audio: { backend: "ASIO" }, displayName: "Singer" }; }
} }));
