import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppProvider, useApp, useRoomSession } from "./AppContext";
import type { RoomStateDto } from "../contracts/models";

const roomPorts = vi.hoisted(() => ({
  createRoom: vi.fn(async () => ({ code: "joined", hostId: "host", role: "host", participants: [], playbackLocked: false })),
  joinVoiceSession: vi.fn(async () => undefined),
}));
vi.mock("../services/audioClient", () => ({ audioClient: {
  joinVoiceSession: roomPorts.joinVoiceSession,
} }));
vi.mock("../services/roomClient", () => ({ roomClient: {
  createRoom: roomPorts.createRoom,
} }));
vi.mock("../services/desktopClient", () => ({ desktopClient: { setAppIcon: vi.fn() } }));
vi.mock("../shared/preferences/appFonts", async (original) => ({
  ...await original<typeof import("../shared/preferences/appFonts")>(), applyAppFonts: vi.fn(),
}));

it("isolates room changes from translations, theme, preferences and action consumers", () => {
  const counts = { language: 0, theme: 0, preferences: 0, actions: 0, room: 0 };
  let actions!: ReturnType<typeof useActions>;
  function useActions() { return useApp("actions"); }
  function Language() { useApp("language"); counts.language++; return null; }
  function Theme() { useApp("theme"); counts.theme++; return null; }
  function Preferences() { useApp("preferences"); counts.preferences++; return null; }
  function Actions() { actions = useActions(); counts.actions++; return null; }
  function Room() { useApp("room"); counts.room++; return null; }
  const view = render(<AppProvider><Language /><Theme /><Preferences /><Actions /><Room /></AppProvider>);
  const before = { ...counts };
  act(() => actions.setRoom({ code: "example" } as unknown as RoomStateDto));
  expect(counts).toEqual({ ...before, room: before.room + 1 });
  act(() => actions.updatePreferences({ musicGain: 0.321 }));
  expect(counts).toEqual({ ...before, room: before.room + 1, preferences: before.preferences + 1 });
  act(() => actions.updatePreferences({ musicGain: 0.321 }));
  expect(counts.preferences).toBe(before.preferences + 1);
  view.unmount();
});

it("subscribes React room views to the application session owner", async () => {
  let session!: ReturnType<typeof useRoomSession>;
  let visibleRoom: string | null = null;
  const Commands = () => { session = useRoomSession(); return null; };
  const Room = () => { visibleRoom = useApp("room").room?.code ?? null; return null; };
  const view = render(<AppProvider><Commands /><Room /></AppProvider>);

  await act(async () => { await session.join("Singer"); });

  expect(visibleRoom).toBe("joined");
  expect(roomPorts.joinVoiceSession).toHaveBeenCalledOnce();
  view.unmount();
});

it("keeps user-enabled animations running when preferences change", () => {
  let actions!: ReturnType<typeof useApp<"actions">>;
  const Capture = () => { actions = useApp("actions"); return null; };
  const view = render(<AppProvider><Capture /></AppProvider>);
  act(() => actions.updatePreferences({ reducedMotion: false }));
  expect(document.documentElement.dataset.adMotion).toBe("on");
  view.unmount();
});
