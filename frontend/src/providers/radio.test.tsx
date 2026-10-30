import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../services/audioClient";
import { subscribeRadio, toggleRadio } from "./radio";
import { store } from "./store";
import { runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, type PropsWithChildren } from "react";
import type { RoomStateDto } from "../contracts/models";

const appState = vi.hoisted(() => ({
  room: null as null | Record<string, unknown>,
  setRoom: vi.fn(),
  publishSharedState: vi.fn(async () => undefined),
  updatePreferences: vi.fn(),
  audioEpoch: 0,
}));


vi.mock("../services/audioClient", () => ({
  audioClient: {
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    stopRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
  },
}));

vi.mock("./application", () => ({ roomSession: { getScope: () => ({}) } }));
vi.mock("../application/room/RoomLibraryCoordinator", () => ({
  RoomLibraryCoordinator: class { publishSharedState = appState.publishSharedState; },
}));
const notify = vi.fn();
const RadioConnection = ({ libraryActive, children }: PropsWithChildren<{ libraryActive: boolean }>) => {
  useLayoutEffect(() => { runInAction(() => {
    store.online.room = appState.room as RoomStateDto | null;
    store.application.services.audioEpoch = appState.audioEpoch;
    store.radio.libraryActive = libraryActive;
  }); }, [libraryActive, appState.room, appState.audioEpoch]);
  useEffect(() => subscribeRadio(notify), []);
  return children;
};

const Controls = observer(() => {
  const radio = store.radio;
  return <button onClick={toggleRadio}>{radio.enabled ? "on" : "off"}</button>;
});

describe("RadioConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(audioClient.playRadio).mockResolvedValue(undefined);
    vi.mocked(audioClient.loadRadio).mockResolvedValue(undefined);
    appState.room = null;
    appState.audioEpoch = 0;
    runInAction(() => {
      store.online.room = null; store.radio.enabled = false; store.radio.libraryActive = false;
      store.radio.preparedKey = ""; store.radio.prepareRequest = 0;
      store.updatePreferences({ radioStation: "groove-salad", radioVolume: 35 });
    });
  });

  it.each([false, true])("reloads a forgotten radio station after an AudioService restart (enabled=%s)", async (enabled) => {
    const view = render(<RadioConnection libraryActive><Controls /></RadioConnection>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(1));
    if (enabled) {
      fireEvent.click(screen.getByRole("button", { name: "off" }));
      await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(1));
    }
    appState.audioEpoch = 1;
    view.rerender(<RadioConnection libraryActive><Controls /></RadioConnection>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(2));
    if (!enabled) fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(enabled ? 2 : 1));
  });

  it("keeps the radio context stable when only room participants change", async () => {
    appState.room = { code: "ROOM", role: "participant", radioEnabled: false,
      radioStationId: "groove-salad", collaborativeControl: true };
    let value: typeof store.radio | undefined;
    const rendered = vi.fn();
    function Consumer() { value = store.radio; rendered(); return null; }
    const child = <Consumer />;
    const view = render(<RadioConnection libraryActive>{child}</RadioConnection>);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalled());
    const original = value;
    expect(original).toBeDefined();
    const count = rendered.mock.calls.length;
    appState.room = { ...appState.room, participants: [{ name: "Updated" }] };
    view.rerender(<RadioConnection libraryActive>{child}</RadioConnection>);
    expect(value).toBe(original);
    expect(rendered).toHaveBeenCalledTimes(count);
  });

  it("prepares the station once and reuses it for instant pause and resume", async () => {
    render(
      <RadioConnection libraryActive>
        <Controls />
      </RadioConnection>,
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
    render(<RadioConnection libraryActive><Controls /></RadioConnection>);
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
    render(<RadioConnection libraryActive><Controls /></RadioConnection>);
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
      <RadioConnection libraryActive>
        <Controls />
      </RadioConnection>,
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
      <RadioConnection libraryActive>
        <Controls />
      </RadioConnection>,
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
      <RadioConnection libraryActive>
        <Controls />
      </RadioConnection>,
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
      <RadioConnection libraryActive>
        <Controls />
      </RadioConnection>,
    );

    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument();
  });

it("ignores an unfinished stream load after unsubscribe", async () => {
  let finish!: () => void;
  vi.mocked(audioClient.loadRadio).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  runInAction(() => { store.radio.enabled = true; });
  const view = render(<RadioConnection libraryActive><Controls /></RadioConnection>);
  await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalled());
  view.unmount();
  const played = vi.mocked(audioClient.playRadio).mock.calls.length;
  await act(async () => { finish(); });
  expect(audioClient.playRadio).toHaveBeenCalledTimes(played);
  expect(store.radio.preparedKey).toBe("");
  expect(audioClient.stopRadio).toHaveBeenCalled();
});

});
