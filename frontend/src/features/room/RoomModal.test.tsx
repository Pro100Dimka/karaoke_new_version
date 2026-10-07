import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { RoomModal } from "./RoomModal";

const ports = vi.hoisted(() => ({
  create: vi.fn(),
  join: vi.fn(),
  joinVoice: vi.fn(async () => undefined),
}));
vi.mock("../../services/roomClient", () => ({ roomClient: {
  createRoom: ports.create,
  joinRoom: ports.join,
} }));
vi.mock("../../services/audioClient", () => ({ audioClient: {
  joinVoiceSession: ports.joinVoice,
} }));
beforeEach(() => vi.clearAllMocks());

describe("RoomModal", () => {
  it("creates a room right away under the trimmed name", async () => {
    const onClose = vi.fn();
    ports.create.mockResolvedValue({
      code: "ROOM42",
      participants: [],
    } as never);
    render(
      <AppProvider>
        <RoomModal open onClose={onClose} />
      </AppProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Имя" }), {
      target: { value: "  Дима " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать комнату" }));
    await waitFor(() =>
      expect(ports.create).toHaveBeenCalledWith("Дима"),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("requires a code to join, and a pasted code joins at once", async () => {
    ports.join.mockResolvedValue({ code: "ROOM42", participants: [] });
    render(
      <AppProvider>
        <RoomModal open onClose={vi.fn()} />
      </AppProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Имя" }), {
      target: { value: "Дима" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Войти в комнату" }));
    expect(await screen.findByText("Обязательное поле")).toBeInTheDocument();
    expect(ports.join).not.toHaveBeenCalled();

    fireEvent.paste(screen.getByRole("textbox", { name: "Код комнаты" }), {
      clipboardData: { getData: () => " ROOM42 " },
    });
    await waitFor(() =>
      expect(ports.join).toHaveBeenCalledWith("ROOM42", "Дима"),
    );
  });
});
