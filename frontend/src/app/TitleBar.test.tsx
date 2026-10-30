import { ru } from "../i18n/messages.ru";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";
const calls = vi.hoisted(() => ({ drag: vi.fn(async () => undefined), fullscreen: true }));
vi.mock("./useWindowState", () => ({ useWindowState: () => ({ fullscreen: calls.fullscreen }) }));
vi.mock("../services/desktopClient", () => ({ desktopClient: { dragWindow: calls.drag } }));

beforeEach(() => vi.clearAllMocks());
it.each([false, true])("moves a window only after a deliberate header drag and follows until release (fullscreen=%s)", (fullscreen) => {
  calls.fullscreen = fullscreen;
  const view = render(<TitleBar />);
  const bar = view.container.querySelector("header")!;
  fireEvent(bar, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 300, clientY: 12, screenX: 300, screenY: 12 }));
  fireEvent(bar, new MouseEvent("pointermove", { bubbles: true, screenX: 302, screenY: 12 }));
  expect(calls.drag).not.toHaveBeenCalled();
  fireEvent(bar, new MouseEvent("pointermove", { bubbles: true, screenX: 340, screenY: 40 }));
  expect(calls.drag).toHaveBeenCalledWith("start", 300 / innerWidth, 12, 340, 40);
  fireEvent(bar, new MouseEvent("pointermove", { bubbles: true, screenX: 400, screenY: 60 }));
  expect(calls.drag).toHaveBeenCalledWith("move", undefined, undefined, 400, 60);
  fireEvent(bar, new MouseEvent("pointerup", { bubbles: true }));
  expect(calls.drag).toHaveBeenLastCalledWith("end");
  calls.drag.mockClear();
  fireEvent(screen.getByRole("button", { name: ru.closeWindow }), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  fireEvent(bar, new MouseEvent("pointermove", { bubbles: true, screenX: 500 }));
  expect(calls.drag).not.toHaveBeenCalled();
});
