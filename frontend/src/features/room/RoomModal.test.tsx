import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { enterRoom } from "./enterRoom";
import { RoomModal } from "./RoomModal";

vi.mock("./enterRoom", () => ({ enterRoom: vi.fn() }));

describe("RoomModal", () => {
  it("opens on the join tab with the name and code fields and the creation shortcut", () => {
    render(<AppProvider><RoomModal open onClose={vi.fn()} /></AppProvider>);

    expect(screen.getByRole("tab", { name: "Войти по коду" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Создать комнату" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("textbox", { name: "Имя" })).toBeRequired();
    expect(screen.getByRole("textbox", { name: "Код комнаты" })).toBeRequired();

    fireEvent.click(screen.getByRole("button", { name: "Нет кода? Создайте комнату и пригласите друзей." }));
    expect(screen.getByRole("tab", { name: "Создать комнату" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox", { name: "Код комнаты" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать комнату" })).toBeInTheDocument();
  });

  it("requires a code to join and enters the room under the trimmed name", async () => {
    const onClose = vi.fn();
    vi.mocked(enterRoom).mockResolvedValue({ code: "ROOM42", participants: [] } as never);
    render(<AppProvider><RoomModal open onClose={onClose} /></AppProvider>);

    fireEvent.change(screen.getByRole("textbox", { name: "Имя" }), { target: { value: "  Дима " } });
    fireEvent.click(screen.getByRole("button", { name: "Войти в комнату" }));
    expect(await screen.findByText("Обязательное поле")).toBeInTheDocument();
    expect(enterRoom).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Код комнаты" }), { target: { value: " ROOM42 " } });
    fireEvent.click(screen.getByRole("button", { name: "Войти в комнату" }));
    await waitFor(() => expect(enterRoom).toHaveBeenCalledWith("Дима", "ROOM42"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
