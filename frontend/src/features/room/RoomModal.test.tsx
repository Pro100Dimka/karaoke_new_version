import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { enterRoom } from "./enterRoom";
import { RoomModal } from "./RoomModal";

vi.mock("./enterRoom", () => ({ enterRoom: vi.fn() }));

describe("RoomModal", () => {
  it("creates a room right away under the trimmed name", async () => {
    const onClose = vi.fn();
    vi.mocked(enterRoom).mockResolvedValue({
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
      expect(enterRoom).toHaveBeenCalledWith("Дима", undefined),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("requires a code to join, and a pasted code joins at once", async () => {
    vi.mocked(enterRoom)
      .mockReset()
      .mockResolvedValue({ code: "ROOM42", participants: [] } as never);
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
    expect(enterRoom).not.toHaveBeenCalled();

    fireEvent.paste(screen.getByRole("textbox", { name: "Код комнаты" }), {
      clipboardData: { getData: () => " ROOM42 " },
    });
    await waitFor(() =>
      expect(enterRoom).toHaveBeenCalledWith("Дима", "ROOM42"),
    );
  });
});
