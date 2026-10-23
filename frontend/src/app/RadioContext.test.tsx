import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../services/audioClient";
import { RadioProvider, useRadio } from "./RadioContext";

const appState = vi.hoisted(() => ({
  room: null as null | Record<string, unknown>,
  setRoom: vi.fn(),
  publishSharedState: vi.fn(async () => undefined),
  updatePreferences: vi.fn(),
  audioEpoch: 0,
}));
vi.mock("./ServicesContext", () => ({ useServices: () => ({ audioEpoch: appState.audioEpoch }) }));

vi.mock("../services/audioClient", () => ({
  audioClient: {
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    stopRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
  },
}));

vi.mock("./AppContext", () => {
  const commands = { publishSharedState: appState.publishSharedState };
  return {
  useRoomLibraryCommands: () => commands,
  useApp: () => ({
    preferences: { radioStation: "groove-salad", radioVolume: 35 },
    updatePreferences: appState.updatePreferences,
    room: appState.room,
    setRoom: appState.setRoom,
  }),
  };
});

vi.mock("./NotificationsProvider", () => {
  const notify = vi.fn();
  return { useNotify: () => notify };
});

const Controls = () => {
  const radio = useRadio();
  return <button onClick={radio.toggle}>{radio.enabled ? "on" : "off"}</button>;
};

describe("RadioProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(audioClient.playRadio).mockResolvedValue(undefined);
    vi.mocked(audioClient.loadRadio).mockResolvedValue(undefined);
    appState.room = null;
    appState.audioEpoch = 0;
  });

  it.each([false, true])("reloads a forgotten radio station after an AudioService restart (enabled=%s)", async (enabled) => {
    const view = render(<RadioProvider libraryActive><Controls /></RadioProvider>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(1));
    if (enabled) {
      fireEvent.click(screen.getByRole("button", { name: "off" }));
      await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(1));
    }
    appState.audioEpoch = 1;
    view.rerender(<RadioProvider libraryActive><Controls /></RadioProvider>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(2));
    if (!enabled) fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(enabled ? 2 : 1));
  });

  it("keeps the radio context stable when only room participants change", async () => {
    appState.room = { code: "ROOM", role: "participant", radioEnabled: false,
      radioStationId: "groove-salad", collaborativeControl: true };
    let value: ReturnType<typeof useRadio> | undefined;
    const rendered = vi.fn();
    function Consumer() { value = useRadio(); rendered(); return null; }
    const child = <Consumer />;
    const view = render(<RadioProvider libraryActive>{child}</RadioProvider>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalled());
    const original = value;
    expect(original).toBeDefined();
    const count = rendered.mock.calls.length;
    appState.room = { ...appState.room, participants: [{ name: "Updated" }] };
    view.rerender(<RadioProvider libraryActive>{child}</RadioProvider>);
    expect(value).toBe(original);
    expect(rendered).toHaveBeenCalledTimes(count);
  });

  it("prepares the station once and reuses it for instant pause and resume", async () => {
    render(
      <RadioProvider libraryActive>
        <Controls />
      </RadioProvider>,
    );

    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(1));
    expect(audioClient.playRadio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "on" }));
    await waitFor(() =>
      expect(audioClient.pauseRadio).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(2));
    expect(audioClient.loadRadio).toHaveBeenCalledTimes(1);
  });

  it("pauses an in-flight play request when the radio is switched off", async () => {
    let finish!: () => void;
    vi.mocked(audioClient.playRadio).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<RadioProvider libraryActive><Controls /></RadioProvider>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "on" }));
    await act(async () => { finish(); });

    expect(screen.getByRole("button", { name: "off" })).toBeInTheDocument();
    expect(audioClient.pauseRadio).toHaveBeenCalledOnce();
  });

  it("does not disable a newer play request when an older play fails", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(audioClient.playRadio).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<RadioProvider libraryActive><Controls /></RadioProvider>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "on" }));
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(2));
    await act(async () => { fail(new Error("obsolete device request")); });

    expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument();
  });

  it("inherits the host radio state and publishes room toggles", async () => {
    appState.room = {
      code: "ROOM",
      role: "participant",
      collaborativeControl: true,
      radioEnabled: true,
      radioStationId: "groove-salad",
      libraryQuery: "",
      libraryStatus: "all",
      librarySort: "recent",
    };
    render(
      <RadioProvider libraryActive>
        <Controls />
      </RadioProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "on" }));

    await waitFor(() =>
      expect(appState.publishSharedState).toHaveBeenCalledWith(
        expect.objectContaining({
          radioEnabled: false,
          radioStationId: "groove-salad",
        }),
      ),
    );
  });

  it("publishes the host's current radio state when the host creates a room", async () => {
    const view = render(
      <RadioProvider libraryActive>
        <Controls />
      </RadioProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument(),
    );

    appState.room = {
      code: "NEW-ROOM",
      role: "host",
      radioEnabled: false,
      radioStationId: "groove-salad",
      libraryQuery: "",
      libraryStatus: "all",
      librarySort: "recent",
    };
    view.rerender(
      <RadioProvider libraryActive>
        <Controls />
      </RadioProvider>,
    );

    await waitFor(() =>
      expect(appState.publishSharedState).toHaveBeenCalledWith(
        expect.objectContaining({
          radioEnabled: true,
          radioStationId: "groove-salad",
        }),
      ),
    );
  });

  it("keeps the authoritative room radio switch enabled when local playback fails", async () => {
    appState.room = {
      code: "ROOM",
      role: "participant",
      radioEnabled: true,
      radioStationId: "groove-salad",
      libraryQuery: "",
      libraryStatus: "all",
      librarySort: "recent",
    };
    vi.mocked(audioClient.playRadio).mockRejectedValueOnce(
      new Error("device busy"),
    );

    render(
      <RadioProvider libraryActive>
        <Controls />
      </RadioProvider>,
    );

    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument();
  });
});
