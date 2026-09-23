import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RoomDock } from "./RoomDock";

let roomState: Record<string, unknown>;

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
    setRoom: vi.fn()
  })
}));
vi.mock("../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string) => ({ roomStart: "Запустить" } as Record<string, string>)[key] ?? key
}));
vi.mock("../../services/pythonClient", () => ({ pythonClient: { listSongs: vi.fn(async () => []) } }));
vi.mock("../../services/roomClient", () => ({
  roomClient: { roomControl: vi.fn(), leaveRoom: vi.fn() }
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: { setParticipantVolume: vi.fn(), leaveVoiceSession: vi.fn() }
}));
vi.mock("../../services/desktopClient", () => ({ desktopClient: { copyText: vi.fn() } }));

describe("RoomDock", () => {
  roomState = undefined as unknown as Record<string, unknown>;
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
});
