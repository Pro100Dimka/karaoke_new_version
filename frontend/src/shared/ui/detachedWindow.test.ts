import { expect, it, vi } from "vitest";
import { carryWindow } from "./detachedWindow";

const pointer = (type: string, screenX: number, screenY: number, buttons = 1) =>
  Object.assign(new MouseEvent(type, { screenX, screenY, buttons }), {
    pointerId: 1,
  });

const panelWindow = () => ({
  closed: false,
  innerWidth: 300,
  innerHeight: 400,
  moveTo: vi.fn(),
});

it("keeps a torn-off panel's window under the pointer until the button is released", () => {
  const panel = panelWindow();
  carryWindow(
    panel as unknown as Window,
    { left: 3000, top: 100, width: 300, height: 400 },
    { screenX: 3050, screenY: 120 },
  );
  window.dispatchEvent(pointer("pointermove", 3250, 320));
  expect(panel.moveTo).toHaveBeenLastCalledWith(3200, 300);
  window.dispatchEvent(pointer("pointerup", 3250, 320, 0));
  window.dispatchEvent(pointer("pointermove", 3500, 500));
  expect(panel.moveTo).toHaveBeenCalledTimes(1);
});

it("keeps the torn-off window where it is released, even over the app's own (maximised) window", () => {
  const panel = panelWindow();
  carryWindow(
    panel as unknown as Window,
    { left: -350, top: 100, width: 300, height: 400 },
    { screenX: -300, screenY: 120 },
  );
  window.dispatchEvent(pointer("pointermove", 200, 220));
  window.dispatchEvent(pointer("pointerup", 200, 220, 0));
  expect(panel.closed).toBe(false);
  expect(panel.moveTo).toHaveBeenLastCalledWith(150, 200);
});
