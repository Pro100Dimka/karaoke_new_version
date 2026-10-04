import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomDock } from "./RoomDock";
import { roomImportDecision, roomTransferFailure } from "./roomProjectDownload";

let roomState: Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  startSyncCheck: vi.fn(),
  setRoom: vi.fn(),
  updatePreferences: vi.fn(),
  transferHost: vi.fn(),
  removeParticipant: vi.fn(),
  closeRoom: vi.fn(),
  leaveRoom: vi.fn(),
  setParticipantEffect: vi.fn(),
  cancelRoomProjectTransfer: vi.fn(),
  listSongs: vi.fn(),
  setMicrophoneEnabled: vi.fn(async () => undefined),
  setParticipantMuted: vi.fn(async () => undefined),
  setParticipantVolume: vi.fn(async (_participantId: string, _gain: number) => undefined),
  setRoomReadiness: vi.fn(),
  personPhoto: undefined as string | undefined,
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({
    room: roomState ?? {
      code: "ROOM42",
      hostId: "host",
      role: "host",
      songId: "song-1",
      revision: 1,
      transferProgress: 70,
      playbackLocked: false,
      participants: []
    },
    setRoom: mocks.setRoom,
    preferences: {
      theme: "dark",
      voiceGain: 0.68,
      noiseSuppression: 0,
      karaokeEffects: { echo: 0, reverb: 0, delay: 0.24, autoTune: 0 },
    },
    updatePreferences: mocks.updatePreferences,
  })
}));
vi.mock("../../app/DialogProvider", () => ({ useAsk: () => mocks.ask }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string) => ({ roomStart: "Запустить" } as Record<string, string>)[key] ?? key
}));
vi.mock("../../services/pythonClient", () => ({ pythonClient: { listSongs: mocks.listSongs } }));
vi.mock("../../services/roomClient", () => ({
  roomClient: {
    roomControl: vi.fn(),
    setRoomReadiness: mocks.setRoomReadiness,
    leaveRoom: mocks.leaveRoom,
    transferHost: mocks.transferHost,
    removeParticipant: mocks.removeParticipant,
    closeRoom: mocks.closeRoom,
    startSyncCheck: mocks.startSyncCheck
  }
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setParticipantVolume: mocks.setParticipantVolume,
    setParticipantEffect: mocks.setParticipantEffect,
    monitoringEnabled: () => false,
    microphoneEnabled: () => true,
    participantMuted: () => false,
    setMicrophoneEnabled: mocks.setMicrophoneEnabled,
    setParticipantMuted: mocks.setParticipantMuted,
    setMonitoring: vi.fn(async () => ({ monitoring: true })),
    leaveVoiceSession: vi.fn(async () => undefined),
    removeRemoteParticipant: vi.fn(async () => undefined),
    roomTiming: vi.fn(async () => ({
      roundTripMs: 34,
      deviceLatencyMs: 10,
      remotes: { friend: { jitterMs: 4.5, targetDelayMs: 30 } },
      estimatedVoiceLatencyMs: 57
    }))
  }
}));
vi.mock("../../services/desktopClient", () => ({ desktopClient: {
  copyText: vi.fn(), cancelRoomProjectTransfer: mocks.cancelRoomProjectTransfer
} }));
vi.mock("../social/usePersonPhoto", () => ({ usePersonPhoto: () => mocks.personPhoto }));

/** Types a value into a Neo knob's readout, as a singer does to set an exact number. */
const typeKnob = (slider: HTMLElement, value: string) => {
  const root = slider.closest(".ad-rotary-knob") as HTMLElement;
  fireEvent.click(root.querySelector(".knob__value") as HTMLElement);
  const input = within(root).getByRole("textbox");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("RoomDock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSongs.mockResolvedValue([]);
    mocks.personPhoto = undefined;
    roomState = undefined as unknown as Record<string, unknown>;
  });
  roomState = undefined as unknown as Record<string, unknown>;
  it("builds every part of the room from Neo UI cards", async () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [
        { id: "host", name: "Host", role: "host", self: true, connected: true,
          muted: false, speakingLevel: 0.5, volume: 1, readiness: "ready" },
        { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }
      ]
    };

    const { container } = render(<MemoryRouter><RoomDock /></MemoryRouter>);
    await waitFor(() => expect(container.querySelector(".roomLink")).toBeInTheDocument());

    expect(screen.getByRole("complementary", { name: "onlineRoom" })).toHaveClass("roomDock");
    for (const part of [".roomHead", ".roomPerson", ".roomLink"])
      expect(container.querySelector(part)).toHaveClass("ad-card");
  });

  it("shows the selected song artwork instead of a decorative theme picture", async () => {
    mocks.listSongs.mockResolvedValue([{
      id: "song-1", title: "Song", artist: "Artist", language: "Auto", status: "ready",
      durationSeconds: 120, createdAt: "2026-01-01", coverState: "Custom",
      activeRevision: 1, projectFormatVersion: 1, artworkUrl: "song-cover.jpg"
    }]);

    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(await screen.findByRole("img", { name: "Song" })).toHaveAttribute("src", "song-cover.jpg");
  });

  it("does not reserve an artwork square when the room has no selected song", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: []
    };

    const { container } = render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(container.querySelector(".roomArt")).not.toBeInTheDocument();
    expect(container.querySelector(".roomHead")).not.toHaveAttribute("data-art");
    expect(mocks.listSongs).not.toHaveBeenCalled();
  });

  it("keeps retry available after a failed transfer clears progress", async () => {
    roomState = { ...roomTransferFailure({ code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [], transferId: "transfer", transferProgress: 45 }) };
    mocks.setRoomReadiness.mockResolvedValue(roomState);
    render(<MemoryRouter><RoomDock /></MemoryRouter>);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retryTransfer" }));
    await waitFor(() => expect(mocks.setRoomReadiness).toHaveBeenCalledWith("ROOM42", "MissingSong"));
  });
  it("offers to replace the singer's own different copy of the song, never replacing it silently", async () => {
    roomState = { ...roomTransferFailure({ code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [], songId: "song-1", revision: 2 }, true) };
    mocks.setRoomReadiness.mockResolvedValue(roomState);
    render(<MemoryRouter><RoomDock /></MemoryRouter>);
    expect(screen.getByText("roomProjectConflict")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "retryTransfer" })).not.toBeInTheDocument();
    expect(roomImportDecision("song-1", 2)).toBe("AcceptOlder");
    fireEvent.click(screen.getByRole("button", { name: "roomReplaceProject" }));
    await waitFor(() => expect(mocks.setRoomReadiness).toHaveBeenCalledWith("ROOM42", "MissingSong"));
    expect(roomImportDecision("song-1", 2)).toBe("AcceptDivergent");
  });
  it("keeps song selection on library cards instead of rendering a selector", () => {
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.queryByRole("button", { name: "roomSelectSong" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Запустить" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "stop" })).not.toBeInTheDocument();
  });

  it("shows room project transfer progress while another participant prepares the selected song", () => {
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByRole("progressbar", { name: "projectTransfer" })).toHaveAttribute("aria-valuenow", "70");
  });

  it("shows the transfer progress and lets the user cancel an active project transfer", async () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [], transferProgress: 25, transferId: "transfer-1",
      transferBytes: 250, transferTotalBytes: 1000
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByText("25%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "roomActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "cancelTransfer" }));
    await waitFor(() =>
      expect(mocks.cancelRoomProjectTransfer).toHaveBeenCalledWith("transfer-1")
    );
  });

  it("uses the same live signal waveform as audio settings for microphone activity", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [{
        id: "host", name: "Singer", role: "host", self: true, connected: true,
        muted: false, speakingLevel: 0.5, volume: 1, readiness: "ready"
      }]
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByRole("meter", { name: "liveInputLevel" })).toHaveAttribute("aria-valuenow", "100");
  });

  it("shows the host as the animated crown seal and a guest as an initials ring with a guest badge", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [
        { id: "host", name: "Singer", role: "host", self: true, connected: true,
          muted: false, speakingLevel: 0.5, volume: 1, readiness: "ready" },
        { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }
      ]
    };

    const { container } = render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByRole("img", { name: "Singer" })).toHaveAttribute("data-variant", "host");
    expect(container.querySelector(".ad-host-seal .host-emblem__crown")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Guest" })).toHaveTextContent("guestBadge");
    expect(container.querySelector(".roomPersonCrown")).not.toBeInTheDocument();
  });

  it("puts the profile photo inside the host seal and moves the crown beside the host name", () => {
    mocks.personPhoto = "data:image/png;base64,profile";
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [{
        id: "host", name: "Singer", role: "host", self: true, connected: true,
        muted: false, speakingLevel: 0.5, volume: 1, readiness: "ready"
      }]
    };

    const { container } = render(<MemoryRouter><RoomDock /></MemoryRouter>);
    const seal = screen.getByRole("img", { name: "Singer" });

    expect(seal).toHaveAttribute("data-photo");
    expect(seal.querySelector(".host-emblem__photo")).toHaveAttribute("href", mocks.personPhoto);
    expect(container.querySelector(".roomPersonCrown")).toBeInTheDocument();
  });

  it("keeps the host row compact while retaining the guest presence caption", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [
        { id: "host", name: "Host", role: "host", self: true, connected: true,
          muted: false, speakingLevel: 0.5, volume: 1, readiness: "ready" },
        { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }
      ]
    };

    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.queryByText("roomYouSpeaking")).not.toBeInTheDocument();
    expect(screen.queryByText("roomParticipantListening")).not.toBeInTheDocument();
  });

  it("shows that room state is reconnecting during a transient signaling outage", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      connectionStatus: "reconnecting", participants: []
    };

    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByRole("status", { name: "roomReconnecting" })).toBeInTheDocument();
  });

  it("checks live voice synchronization from the room dock without opening karaoke", async () => {
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByRole("button", { name: "leaveRoom" })).toBeInTheDocument();
    // The room latency is on screen without any click; the menu only starts the audible check.
    await waitFor(() => expect(screen.getByText("roomLatencyLabel")).toBeInTheDocument());
    expect(screen.getByRole("status", { name: "roomSyncResult" })).toBeInTheDocument();
    mocks.startSyncCheck.mockResolvedValue(roomState);
    fireEvent.click(screen.getByRole("button", { name: "roomActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "roomCheckSync" }));
    await waitFor(() => expect(mocks.startSyncCheck).toHaveBeenCalled());
  });

  it("keeps the host's actions for a participant behind that participant's sliders button", async () => {
    const participants = [
      { id: "host", name: "Host", role: "host", self: true, connected: true,
        muted: false, speakingLevel: 0, volume: 1, readiness: "ready" },
      { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
        muted: false, speakingLevel: 0, volume: 1, readiness: "missing" }
    ];
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants
    };
    mocks.transferHost.mockResolvedValue(roomState);
    mocks.removeParticipant.mockResolvedValue({ ...roomState, participants: [participants[0]] });
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.queryByRole("button", { name: "transferHostAction" })).not.toBeInTheDocument();
    const guest = screen.getByText("Guest").closest(".participant") as HTMLElement;
    fireEvent.click(within(guest).getByRole("button", { name: "participantEffects" }));
    fireEvent.click(screen.getByRole("button", { name: "transferHostAction" }));
    await waitFor(() => expect(mocks.transferHost).toHaveBeenCalledWith("ROOM42", "guest"));
    mocks.ask.mockResolvedValueOnce("remove");
    fireEvent.click(within(guest).getByRole("button", { name: "participantEffects" }));
    fireEvent.click(screen.getByRole("button", { name: "removeParticipant" }));
    await waitFor(() => expect(mocks.removeParticipant).toHaveBeenCalledWith("ROOM42", "guest"));

    mocks.ask.mockResolvedValueOnce("close");
    fireEvent.click(screen.getByRole("button", { name: "leaveRoom" }));
    await waitFor(() => expect(mocks.closeRoom).toHaveBeenCalledWith("ROOM42"));
  });

  it("opens isolated effects for a remote participant and sends the selected value", async () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [
        { id: "host", name: "Host", role: "host", self: true, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" },
        { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }
      ]
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    const guest = screen.getByText("Guest").closest(".participant") as HTMLElement;
    typeKnob(within(guest).getByRole("slider", { name: "participantVolume" }), "35");
    expect(mocks.setParticipantVolume).toHaveBeenCalledWith("guest", 0.35);
    fireEvent.click(within(guest).getByRole("button", { name: "participantEffects" }));
    for (const name of ["effectReverb", "effectEcho", "noiseSuppression", "participantOctave", "effectAutoTune"])
      expect(screen.getByRole("slider", { name }).closest(".ad-rotary-knob")).not.toBeNull();
    expect(screen.queryByRole("slider", { name: "participantDelay" })).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "participantOctave" })).toHaveAttribute("aria-valuetext", "0");
    typeKnob(screen.getByRole("slider", { name: "effectReverb" }), "60");
    await waitFor(() => expect(mocks.setParticipantEffect).toHaveBeenCalledWith("guest", "reverb", 0.6));
    typeKnob(screen.getByRole("slider", { name: "effectAutoTune" }), "75");
    await waitFor(() => expect(mocks.setParticipantEffect).toHaveBeenCalledWith("guest", "autoTune", 0.75));
  });

  it("opens the microphone effects in a popover instead of expanding the participant card", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [{
        id: "host", name: "Host", role: "host", self: true, connected: true,
        muted: false, speakingLevel: 0, volume: 1, readiness: "ready"
      }]
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    const card = screen.getByText("Host").closest(".roomPerson");
    fireEvent.click(screen.getByRole("button", { name: "participantEffects" }));
    const reverb = screen.getByRole("slider", { name: "effectReverb" });

    expect(reverb.closest("[popover]")).not.toBeNull();
    expect(card).not.toContainElement(reverb);
  });

  it("makes your own row control your stored microphone volume and voice effects", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [{
        id: "host", name: "Host", role: "host", self: true, connected: true,
        muted: false, speakingLevel: 0, volume: 1, readiness: "ready"
      }]
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    const microphone = screen.getByRole("slider", { name: "mixerMicrophone" });
    expect(microphone).toHaveAttribute("aria-valuenow", "0.68");
    typeKnob(microphone, "50");
    expect(mocks.updatePreferences).toHaveBeenCalledWith({ voiceGain: 0.5 });

    fireEvent.click(screen.getByRole("button", { name: "participantEffects" }));
    typeKnob(screen.getByRole("slider", { name: "effectReverb" }), "40");
    expect(mocks.updatePreferences).toHaveBeenLastCalledWith({
      karaokeEffects: { echo: 0, reverb: 0.4, delay: 0.24, autoTune: 0 },
    });
    expect(mocks.setParticipantEffect).not.toHaveBeenCalled();
  });

  it("turns your own microphone off without touching its volume, and mutes others only for you", async () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [
        { id: "host", name: "Host", role: "host", self: true, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" },
        { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }
      ]
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "muteMicrophone" }));
    await waitFor(() => expect(mocks.setMicrophoneEnabled).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "unmuteMicrophone" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "muteParticipant" }));
    await waitFor(() => expect(mocks.setParticipantMuted).toHaveBeenCalledWith("guest", true));
    expect(mocks.updatePreferences).not.toHaveBeenCalled();
  });

  it("moves a remote volume knob locally and sends only its committed value", () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [
        { id: "host", name: "Host", role: "host", self: true, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" },
        { id: "guest", name: "Guest", role: "participant", self: false, connected: true,
          muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }
      ]
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);
    const guest = screen.getByText("Guest").closest(".participant") as HTMLElement;
    const knob = within(guest).getByRole("slider", { name: "participantVolume" });
    // A 100 px knob dragged from its centre: 16 px up is a tenth of its turn, 100 % → 120 %.
    knob.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    knob.setPointerCapture = vi.fn();
    knob.hasPointerCapture = () => false;
    const pointer = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({ button: 0, isPrimary: true, pointerId: 4, clientX: 50, clientY }))
        Object.defineProperty(event, key, { value });
      fireEvent(knob, event);
    };

    pointer("pointerdown", 50);
    pointer("pointermove", 42);
    pointer("pointermove", 34);

    expect(mocks.setParticipantVolume).not.toHaveBeenCalled();
    expect(Number(knob.getAttribute("aria-valuenow"))).toBeCloseTo(1.2);

    pointer("pointerup", 34);
    expect(mocks.setParticipantVolume).toHaveBeenCalledTimes(1);
    expect(mocks.setParticipantVolume.mock.calls[0]?.[0]).toBe("guest");
    expect(mocks.setParticipantVolume.mock.calls[0]?.[1]).toBeCloseTo(1.2);
  });
});
