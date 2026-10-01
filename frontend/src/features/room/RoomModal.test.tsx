import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { RoomModal } from "./RoomModal";

vi.mock("./enterRoom", () => ({ enterRoom: vi.fn() }));

describe("RoomModal reference layout", () => {
  it("opens on the join tab with the complete reference form and creation shortcut", () => {
    render(<AppProvider><RoomModal open onClose={vi.fn()} /></AppProvider>);

    expect(screen.getByRole("tab", { name: "Войти по коду" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Создать комнату" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Имя *")).toBeInTheDocument();
    expect(screen.getByLabelText("Код комнаты *")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Нет кода? Создайте комнату и пригласите друзей." })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Создать комнату" }));
    expect(screen.queryByLabelText("Код комнаты *")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать комнату" })).toBeInTheDocument();
  });
});
