import SettingsModal, { openSettings } from "../pages/library/modals/settings";
import { readText, removeKey, storageKey } from "../shared/storage/localStore";
import { useLocale } from "@neo-ui-kit/react";
import LocalizationProvider from "./localization";
import { observer } from "mobx-react-lite";
import { store } from "./store";
import { QueryProvider } from "../test/QueryProvider";
import { act, render, waitFor, screen, fireEvent } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { roomSession } from "./application";
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
  let session!: typeof roomSession;
  function useActions() { return store; }
  function Language() { useLocale(); counts.language++; return null; }
  const Theme = observer(() => { store.currentTheme; counts.theme++; return null; });
  const Preferences = observer(() => { store.preferences; counts.preferences++; return null; });
  function Actions() { actions = useActions(); session = roomSession; counts.actions++; return null; }
  const Room = observer(() => { store.online.room; counts.room++; return null; });
  const view = render(<QueryProvider application><LocalizationProvider><Language /><Theme /><Preferences /><Actions /><Room /></LocalizationProvider></QueryProvider>);
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
  let session!: typeof roomSession;
  let visibleRoom: string | null = null;
  const Commands = () => { session = roomSession; return null; };
  const Room = observer(() => { visibleRoom = store.online.room?.code ?? null; return null; });
  const view = render(<QueryProvider application><Commands /><Room /></QueryProvider>);

  await act(async () => { await session.join("Singer"); });

  expect(visibleRoom).toBe("joined");
  expect(roomPorts.joinVoiceSession).toHaveBeenCalledOnce();
  view.unmount();
});

it("does not expose room snapshot mutation through presentation actions", () => {
  let actions!: typeof store;
  const Capture = () => { actions = store; return null; };
  const view = render(<QueryProvider application><Capture /></QueryProvider>);
  expect(actions).not.toHaveProperty("setRoom");
  view.unmount();
});

it("keeps user-enabled animations running when preferences change", () => {
  let actions!: typeof store;
  const Capture = () => { actions = store; return null; };
  const view = render(<QueryProvider application><Capture /></QueryProvider>);
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
  const view = render(<QueryProvider application>{null}</QueryProvider>);
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

it("keeps settings border motion enabled while opening and closing settings", async () => {
  const view = render(<QueryProvider application><SettingsModal onOpenChange={() => {}} /></QueryProvider>);
  act(() => store.updatePreferences({ reducedMotion: false }));
  expect(document.documentElement.dataset.adMotion).toBe("on");
  await act(async () => openSettings());
  expect(document.documentElement.dataset.adMotion).toBe("on");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
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
    let actions!: typeof store;
    let preferences!: typeof store.preferences;
    const Capture = observer(() => {
      actions = store;
      preferences = store.preferences;
      return null;
    });
    const view = render(
      <QueryProvider application>
        <Capture />
      </QueryProvider>,
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
  const view = render(<QueryProvider application>{null}</QueryProvider>);
  await waitFor(() => expect(jobs.list).toHaveBeenCalled());
  expect(document.documentElement.dataset.adMotion).toBe("on");
  view.unmount();
});

it("disposes the connection without erasing the persisted room for the next mount", async () => {
  const view = render(<QueryProvider application>{null}</QueryProvider>);
  const previous = roomSession;
  await act(async () => { await previous.join("Singer"); });
  const key = storageKey("roomSession");
  expect(readText(key)).toBe("joined");
  view.unmount();
  expect(roomSession).not.toBe(previous);
  expect(store.online.room).toBeNull();
  expect(readText(key)).toBe("joined");
  removeKey(key);
});
