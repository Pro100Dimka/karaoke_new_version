import { expect, it, vi } from "vitest";
import { carryWindow } from "./detachedWindow";

const pointer = (type: string, screenX: number, screenY: number, buttons = 1) =>
  Object.assign(new MouseEvent(type, { screenX, screenY, buttons }), { pointerId: 1 });

const panelWindow = () => ({ closed: false, innerWidth: 300, innerHeight: 400, moveTo: vi.fn() });

it("keeps a torn-off panel's window under the pointer until the button is released", () => {
  const panel = panelWindow();
  const drop = vi.fn();
  carryWindow(panel as unknown as Window, { left: 3000, top: 100, width: 300, height: 400 }, { screenX: 3050, screenY: 120 }, drop);
  window.dispatchEvent(pointer("pointermove", 3250, 320));
  expect(panel.moveTo).toHaveBeenLastCalledWith(3200, 300);
  window.dispatchEvent(pointer("pointerup", 3250, 320, 0));
  window.dispatchEvent(pointer("pointermove", 3500, 500));
  expect(panel.moveTo).toHaveBeenCalledTimes(1);
  expect(drop).not.toHaveBeenCalled();
});

it("returns the panel into the app where it is dropped onto the app's window", () => {
  const panel = panelWindow();
  const drop = vi.fn();
  carryWindow(panel as unknown as Window, { left: -350, top: 100, width: 300, height: 400 }, { screenX: -300, screenY: 120 }, drop);
  window.dispatchEvent(pointer("pointerup", 200, 220, 0));
  expect(drop).toHaveBeenCalledWith({ left: 150, top: 200, width: 300, height: 400 });
});
