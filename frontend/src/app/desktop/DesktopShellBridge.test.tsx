import { act, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopClient } from "../../services/desktopClient";
import { DesktopShellBridge } from "./DesktopShellBridge";
import {
  createCommandQueue,
  displayCount,
  libraryCommands,
  microphoneToggled,
  nowPlaying,
  onBattery,
  updateReady,
  type LibraryCommand,
} from "./shellBus";

const state = vi.hoisted(() => ({
  radio: { enabled: false, stationId: "groove-salad", volume: 50, canControl: true, toggle: vi.fn(), setStation: vi.fn(), setVolume: vi.fn() },
  room: null as null | { code: string; participants: unknown[] },
  micEnabled: true,
  setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
    state.micEnabled = enabled;
  }),
  notify: vi.fn(),
  listener: null as null | ((command: unknown) => void),
}));
vi.mock("../RadioContext", () => ({ useRadio: () => state.radio }));
vi.mock("../NotificationsProvider", () => ({ useNotify: () => state.notify }));
vi.mock("../AppContext", () => ({
  useApp: (slice: string) =>
    slice === "room"
      ? { room: state.room }
      : slice === "language"
        ? { language: "ru" }
        : { preferences: { discordPresence: true } },
  useRoomVoice: () =>
    state.room ? { microphoneEnabled: () => state.micEnabled, setMicrophoneEnabled: state.setMicrophoneEnabled } : null,
}));
vi.mock("../../services/desktopClient", () => ({
  desktopClient: {
    reportShellStatus: vi.fn(async () => undefined),
    onShellCommand: vi.fn((listener: (command: unknown) => void) => {
      state.listener = listener;
      return () => undefined;
    }),
  },
}));

let path = "";
const Where = () => {
  path = useLocation().pathname;
  return null;
};
const renderAt = (route: string) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <DesktopShellBridge />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
const send = (command: unknown) => act(() => state.listener?.(command));
const lastStatus = () => vi.mocked(desktopClient.reportShellStatus).mock.lastCall?.[0] as Record<string, unknown>;

afterEach(() => {
  state.room = null;
  nowPlaying.set(null);
  onBattery.set(false);
  updateReady.set(null);
  displayCount.set(1);
  vi.clearAllMocks();
});

describe("command queue", () => {
  it("holds commands until a handler subscribes, then delivers them in order", () => {
    const queue = createCommandQueue<string>();
    queue.push("a");
    queue.push("b");
    const handler = vi.fn();
    const unsubscribe = queue.subscribe(handler);
    expect(handler.mock.calls.map(([value]) => value)).toEqual(["a", "b"]);
    queue.push("c");
    expect(handler).toHaveBeenLastCalledWith("c");
    unsubscribe();
    queue.push("d");
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe("DesktopShellBridge", () => {
  it("reports what plays in Karaoke and the room, without the radio there", () => {
    state.room = { code: "AB12", participants: [{}, {}] };
    nowPlaying.set({ title: "Люди", artist: "Бумбокс", playing: true, recording: false, togglePlayback: vi.fn() });
    renderAt("/karaoke/song-1");
    expect(lastStatus()).toMatchObject({
      language: "ru",
      screen: "karaoke",
      song: { title: "Люди", artist: "Бумбокс" },
      playing: true,
      room: { code: "AB12", participants: 2 },
      radio: { available: false },
      microphoneMuted: false,
      discordPresence: true,
    });
  });

  it("drives Karaoke's transport, the radio and the microphone", async () => {
    const togglePlayback = vi.fn();
    nowPlaying.set({ title: "Люди", playing: false, recording: false, togglePlayback });
    state.room = { code: "AB12", participants: [{}] };
    renderAt("/");
    send({ type: "togglePlayback" });
    expect(togglePlayback).toHaveBeenCalledOnce();
    send({ type: "toggleRadio" });
    expect(state.radio.toggle).toHaveBeenCalledOnce();
    send({ type: "nextStation" });
    expect(state.radio.setStation).toHaveBeenCalledWith("secret-agent");
    const toggles = microphoneToggled.get();
    await act(async () => {
      state.listener?.({ type: "toggleMicrophone" });
      await Promise.resolve();
    });
    expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(microphoneToggled.get()).toBe(toggles + 1);
    send({ type: "power", onBattery: true });
    expect(onBattery.get()).toBe(true);
    send({ type: "updateReady", version: "1.3.0" });
    expect(updateReady.get()).toBe("1.3.0");
    send({ type: "displays", count: 2 });
    expect(displayCount.get()).toBe(2);
    send({ type: "nonsense" });
    send(null);
  });

  it("hands Library work to the Library, but never pulls a singer out of Karaoke", () => {
    const received: LibraryCommand[] = [];
    const unsubscribe = libraryCommands.subscribe((command) => received.push(command));
    renderAt("/karaoke/song-1");
    send({ type: "joinRoom", code: "AB12" });
    expect(received).toEqual([{ type: "openRoom", code: "AB12" }]);
    expect(path).toBe("/karaoke/song-1");
    expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("библиотек"), "info");
    unsubscribe();
  });

  it("opens the Library for files opened with the app from another screen", () => {
    const received: LibraryCommand[] = [];
    const unsubscribe = libraryCommands.subscribe((command) => received.push(command));
    renderAt("/somewhere");
    send({ type: "importFiles", paths: ["D:/a.mp3", 5, "D:/b.wav"] });
    expect(received).toEqual([{ type: "importFiles", paths: ["D:/a.mp3", "D:/b.wav"] }]);
    expect(path).toBe("/");
    unsubscribe();
  });
});
