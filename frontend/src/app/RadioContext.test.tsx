import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../services/audioClient";
import { RadioProvider, useRadio } from "./RadioContext";

const appState = vi.hoisted(() => ({ room: null as null | Record<string, unknown>, setRoom: vi.fn() }));

vi.mock("../services/audioClient", () => ({
  audioClient: {
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    stopRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
  },
}));

vi.mock("./AppContext", () => ({
  useApp: () => ({
    preferences: { radioStation: "groove-salad", radioVolume: 35 },
    updatePreferences: vi.fn(),
    room: appState.room,
    setRoom: appState.setRoom,
  }),
}));

vi.mock("../services/roomClient", () => ({
  roomClient: { updateSharedState: vi.fn(async (_code: string, state: Record<string, unknown>) => ({ code: "ROOM", ...state })) }
}));

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
    await waitFor(() => expect(audioClient.pauseRadio).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(2));
    expect(audioClient.loadRadio).toHaveBeenCalledTimes(1);
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
      librarySort: "recent"
    };
    const { roomClient } = await import("../services/roomClient");
    render(<RadioProvider libraryActive><Controls /></RadioProvider>);

    await waitFor(() => expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "on" }));

    await waitFor(() => expect(roomClient.updateSharedState).toHaveBeenCalledWith(
      "ROOM",
      expect.objectContaining({ radioEnabled: false, radioStationId: "groove-salad" })
    ));
  });

  it("publishes the host's current radio state when the host creates a room", async () => {
    const { roomClient } = await import("../services/roomClient");
    const view = render(<RadioProvider libraryActive><Controls /></RadioProvider>);
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument());

    appState.room = {
      code: "NEW-ROOM", role: "host", radioEnabled: false, radioStationId: "groove-salad",
      libraryQuery: "", libraryStatus: "all", librarySort: "recent"
    };
    view.rerender(<RadioProvider libraryActive><Controls /></RadioProvider>);

    await waitFor(() => expect(roomClient.updateSharedState).toHaveBeenCalledWith(
      "NEW-ROOM", expect.objectContaining({ radioEnabled: true, radioStationId: "groove-salad" })
    ));
  });

  it("keeps the authoritative room radio switch enabled when local playback fails", async () => {
    appState.room = {
      code: "ROOM", role: "participant", radioEnabled: true, radioStationId: "groove-salad",
      libraryQuery: "", libraryStatus: "all", librarySort: "recent"
    };
    vi.mocked(audioClient.playRadio).mockRejectedValueOnce(new Error("device busy"));

    render(<RadioProvider libraryActive><Controls /></RadioProvider>);

    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument();
  });
});
