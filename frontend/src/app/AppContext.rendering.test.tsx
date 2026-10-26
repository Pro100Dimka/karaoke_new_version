import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AppProvider, useApp, useRoomSession, useSettingsDialog } from "./AppContext";
import type { ProcessingJobDto, RoomStateDto } from "../contracts/models";

const jobs = vi.hoisted(() => ({
  list: vi.fn<() => Promise<ProcessingJobDto[]>>(async () => []),
  refresh: () => {},
}));
vi.mock("../services/pythonClient", () => ({
  pythonClient: { listJobs: jobs.list },
}));
vi.mock("../services/backendEvents", () => ({
  backendEventsAvailable: () => true,
  refreshOnJobChanges: (refresh: () => void) => {
    jobs.refresh = refresh;
    return () => {};
  },
}));
beforeEach(() => jobs.list.mockResolvedValue([]));

const roomPorts = vi.hoisted(() => ({
  createRoom: vi.fn(async () => ({ code: "joined", hostId: "host", role: "host", participants: [], playbackLocked: false })),
  joinVoiceSession: vi.fn(async () => undefined),
  setRoomPlayoutDelay: vi.fn(async () => undefined),
}));
vi.mock("../services/audioClient", () => ({ audioClient: {
  joinVoiceSession: roomPorts.joinVoiceSession,
  setRoomPlayoutDelay: roomPorts.setRoomPlayoutDelay,
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
  let session!: ReturnType<typeof useRoomSession>;
  function useActions() { return useApp("actions"); }
  function Language() { useApp("language"); counts.language++; return null; }
  function Theme() { useApp("theme"); counts.theme++; return null; }
  function Preferences() { useApp("preferences"); counts.preferences++; return null; }
  function Actions() { actions = useActions(); session = useRoomSession(); counts.actions++; return null; }
  function Room() { useApp("room"); counts.room++; return null; }
  const view = render(<AppProvider><Language /><Theme /><Preferences /><Actions /><Room /></AppProvider>);
  const before = { ...counts };
  act(() => session.setSnapshot({ code: "example" } as unknown as RoomStateDto));
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

it("does not expose room snapshot mutation through presentation actions", () => {
  let actions!: ReturnType<typeof useApp<"actions">>;
  const Capture = () => { actions = useApp("actions"); return null; };
  const view = render(<AppProvider><Capture /></AppProvider>);
  expect(actions).not.toHaveProperty("setRoom");
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

it("wakes the kit animation clock after desktop restore even without browser visibility events", () => {
  let publish!: (shown: boolean) => void;
  Object.assign(window, { desktop: { onAppVisibility: (listener: typeof publish) => {
    publish = listener;
    return vi.fn();
  } } });
  const wake = vi.fn();
  document.addEventListener("visibilitychange", wake);
  const view = render(<AppProvider>{null}</AppProvider>);
  wake.mockClear();
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      act(() => publish(false));
      expect(document.documentElement.dataset.adMotion).toBe("off");
      expect(wake).toHaveBeenCalledTimes(cycle);
      act(() => publish(true));
      expect(document.documentElement.dataset.adMotion).toBe("on");
      expect(wake).toHaveBeenCalledTimes(cycle + 1);
    }
  } finally {
    view.unmount();
    document.removeEventListener("visibilitychange", wake);
    Reflect.deleteProperty(window, "desktop");
  }
});

it("keeps settings border motion enabled while opening and closing settings", () => {
  let actions!: ReturnType<typeof useApp<"actions">>;
  let dialog!: ReturnType<typeof useSettingsDialog>;
  const Capture = () => {
    actions = useApp("actions");
    dialog = useSettingsDialog();
    return null;
  };
  const view = render(<AppProvider><Capture /></AppProvider>);
  act(() => actions.updatePreferences({ reducedMotion: false }));
  expect(document.documentElement.dataset.adMotion).toBe("on");
  act(() => actions.openSettings());
  expect(document.documentElement.dataset.adMotion).toBe("on");
  act(() => dialog.setSettingsOpen(false));
  expect(document.documentElement.dataset.adMotion).toBe("on");
  view.unmount();
});

it.each(["queued", "processing", "cancelling"] as const)(
  "stops all motion for a local %s song job and restores it after the last job",
  async (state) => {
    const job = {
      id: "job",
      type: "SongProcessing",
      state,
      processingBackend: "Local",
    } as ProcessingJobDto;
    jobs.list.mockResolvedValue([job, { ...job, id: "second" }]);
    let actions!: ReturnType<typeof useApp<"actions">>;
    let preferences!: ReturnType<typeof useApp<"preferences">>["preferences"];
    const Capture = () => {
      actions = useApp("actions");
      preferences = useApp("preferences").preferences;
      return null;
    };
    const view = render(
      <AppProvider>
        <Capture />
      </AppProvider>,
    );
    act(() => actions.updatePreferences({ reducedMotion: false }));
    await waitFor(() =>
      expect(document.documentElement.dataset.adMotion).toBe("off"),
    );
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    expect(preferences.reducedMotion).toBe(false);
    jobs.list.mockResolvedValue([job]);
    await act(async () => jobs.refresh());
    expect(document.documentElement.dataset.adMotion).toBe("off");
    jobs.list.mockResolvedValue([]);
    await act(async () => jobs.refresh());
    await waitFor(() =>
      expect(document.documentElement.dataset.adMotion).toBe("on"),
    );
    expect(document.documentElement.dataset.reducedMotion).toBe("false");
    view.unmount();
  },
);

it.each([
  { type: "SongProcessing", state: "processing", processingBackend: "Kaggle" },
  { type: "SongProcessing", state: "completed", processingBackend: "Local" },
  { type: "SongProcessing", state: "failed", processingBackend: "Local" },
  { type: "SongProcessing", state: "cancelled", processingBackend: "Local" },
  { type: "SongProcessing", state: "interrupted", processingBackend: "Local" },
  { type: "ModelDownload", state: "processing", processingBackend: "Local" },
])("keeps motion enabled for $type/$state/$processingBackend", async (job) => {
  jobs.list.mockResolvedValue([job as ProcessingJobDto]);
  const view = render(<AppProvider>{null}</AppProvider>);
  await waitFor(() => expect(jobs.list).toHaveBeenCalled());
  expect(document.documentElement.dataset.adMotion).toBe("on");
  view.unmount();
});
