import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RoomDock } from "./RoomDock";

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({
    room: {
      code: "ROOM42",
      hostId: "host",
      role: "host",
      songId: "song-1",
      revision: 1,
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
  it("keeps song selection on library cards instead of rendering a selector", () => {
    render(<MemoryRouter><RoomDock /></MemoryRouter>);

    expect(screen.queryByRole("button", { name: "roomSelectSong" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Запустить" })).toBeInTheDocument();
  });
});
