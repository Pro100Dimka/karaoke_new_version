import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { useFloatingPanel, type PanelLayout } from "./useFloatingPanel";

const pointer = (clientX: number, clientY: number, target: Element = document.body, screen = [clientX, clientY]) => ({
  button: 0, clientX, clientY, screenX: screen[0], screenY: screen[1], target, pointerId: 1,
  currentTarget: { setPointerCapture: () => undefined },
  stopPropagation: () => undefined,
}) as unknown as React.PointerEvent<HTMLElement>;

const mount = (onTearOff = vi.fn(), save = vi.fn()) => {
  const layout: PanelLayout = { left: 100, top: 100, width: 300, height: 600 };
  const { result } = renderHook(() => {
    const ref = useRef<HTMLElement>(null);
    return useFloatingPanel(ref, { layout, onLayoutChange: save, onDragOutside: onTearOff });
  });
  return { result, onTearOff, save };
};

it("moves the panel inside the window and saves where it was left", () => {
  const { result, save } = mount();
  act(() => result.current.beginMove(pointer(150, 150)));
  act(() => result.current.handleMove(pointer(250, 180)));
  act(() => result.current.handleUp());
  expect(save).toHaveBeenCalledWith({ left: 200, top: 130, width: 300, height: 600 });
});

it("turns into a window of its own where it is held once dragged past the window's edge", () => {
  const { result, onTearOff, save } = mount();
  act(() => result.current.beginMove(pointer(150, 150)));
  act(() => result.current.handleMove(pointer(-40, 150, document.body, [2400, 500])));
  expect(onTearOff).toHaveBeenCalledWith({ left: 2350, top: 450, width: 300, height: 600 }, { screenX: 2400, screenY: 500 });
  act(() => result.current.handleUp());
  expect(save).not.toHaveBeenCalled();
});

it("leaves presses on the panel's controls to those controls", () => {
  const { result, save } = mount();
  const button = document.createElement("button");
  document.body.append(button);
  act(() => result.current.beginMove(pointer(150, 150, button)));
  act(() => result.current.handleMove(pointer(400, 400)));
  act(() => result.current.handleUp());
  expect(save).not.toHaveBeenCalled();
  button.remove();
});

it("does not steal pointer capture from a composite control such as a rotary knob", () => {
  const { result, save } = mount();
  const control = document.createElement("div");
  const artwork = document.createElement("span");
  const setPointerCapture = vi.fn();
  control.className = "ad-rotary-knob";
  control.append(artwork);
  document.body.append(control);

  act(() => result.current.beginMove({
    ...pointer(150, 150, artwork),
    currentTarget: { setPointerCapture },
  } as unknown as React.PointerEvent<HTMLElement>));
  act(() => result.current.handleMove(pointer(400, 400)));
  act(() => result.current.handleUp());

  expect(setPointerCapture).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  control.remove();
});
