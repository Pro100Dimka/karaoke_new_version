import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomDock } from "./RoomDock";
import { roomTransferFailure } from "./roomProjectDownload";

let roomState: Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  setRoom: vi.fn(),
  transferHost: vi.fn(),
  removeParticipant: vi.fn(),
  closeRoom: vi.fn(),
  leaveRoom: vi.fn()
  ,setParticipantEffect: vi.fn(),
  cancelRoomProjectTransfer: vi.fn()
  ,setRoomReadiness: vi.fn()
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
    setRoom: mocks.setRoom
  })
}));
vi.mock("../../app/DialogProvider", () => ({ useAsk: () => mocks.ask }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string) => ({ roomStart: "Запустить" } as Record<string, string>)[key] ?? key
}));
vi.mock("../../services/pythonClient", () => ({ pythonClient: { listSongs: vi.fn(async () => []) } }));
vi.mock("../../services/roomClient", () => ({
  roomClient: {
    roomControl: vi.fn(),
    setRoomReadiness: mocks.setRoomReadiness,
    leaveRoom: mocks.leaveRoom,
    transferHost: mocks.transferHost,
    removeParticipant: mocks.removeParticipant,
    closeRoom: mocks.closeRoom,
    startSyncCheck: vi.fn(async () => roomState)
  }
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setParticipantVolume: vi.fn(),
    setParticipantEffect: mocks.setParticipantEffect,
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

describe("RoomDock", () => {
  beforeEach(() => { vi.clearAllMocks(); roomState = undefined as unknown as Record<string, unknown>; });
  roomState = undefined as unknown as Record<string, unknown>;
  it("keeps retry available after a failed transfer clears progress", async () => {
    roomState = { ...roomTransferFailure({ code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [], transferId: "transfer", transferProgress: 45 }) };
    mocks.setRoomReadiness.mockResolvedValue(roomState);
    render(<MemoryRouter><RoomDock /></MemoryRouter>);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retryTransfer" }));
    await waitFor(() => expect(mocks.setRoomReadiness).toHaveBeenCalledWith("ROOM42", "MissingSong"));
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

  it("shows byte progress and lets the user cancel an active project transfer", async () => {
    roomState = {
      code: "ROOM42", hostId: "host", role: "host", playbackLocked: false,
      participants: [], transferProgress: 25, transferId: "transfer-1",
      transferBytes: 250, transferTotalBytes: 1000
    };
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.getByText("250 B / 1000 B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "cancelTransfer" }));
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

    fireEvent.click(screen.getByRole("button", { name: "roomCheckSync" }));

    await waitFor(() => expect(screen.getByText("57 ms")).toBeInTheDocument());
    expect(screen.getByText("RTT 34 ms · jitter 4.5 ms")).toBeInTheDocument();
  });

  it("groups the host participant actions under the same three-dot menu as song cards", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "moreActions" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "transferHostAction" }));
    await waitFor(() => expect(mocks.transferHost).toHaveBeenCalledWith("ROOM42", "guest"));
    mocks.ask.mockResolvedValueOnce("remove");
    fireEvent.click(screen.getByRole("button", { name: "moreActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "removeParticipant" }));
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

    const volume = screen.getByRole("slider", { name: "participantVolume" });
    expect(volume.closest(".ui-rotary-knob")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "moreActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "participantEffects" }));
    for (const name of [
      "participantReverb",
      "participantEcho",
      "participantNoiseSuppression",
      "participantOctave",
    ]) {
      expect(screen.getByRole("slider", { name }).closest(".ui-rotary-knob")).not.toBeNull();
    }
    expect(screen.queryByRole("slider", { name: "participantDelay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "participantNoiseSuppression" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "participantOctave" })).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "participantOctave" })).toHaveAttribute("aria-valuetext", "0");
    fireEvent.change(screen.getByRole("slider", { name: "participantReverb" }), {
      target: { value: "0.6" }
    });

    await waitFor(() =>
      expect(mocks.setParticipantEffect).toHaveBeenCalledWith("guest", "reverb", 0.6)
    );
  });
});
