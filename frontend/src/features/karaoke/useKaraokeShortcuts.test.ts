import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useKaraokeShortcuts } from "./useKaraokeShortcuts";

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  interactive: true,
  practiceLocked: false,
  position: 30,
  speed: 1,
  showNotes: true,
  showLyrics: true,
  gains: { master: 0.8 },
  togglePlay: vi.fn(async () => undefined),
  seek: vi.fn(async () => undefined),
  changeGain: vi.fn(async () => undefined),
  changeKey: vi.fn(async () => undefined),
  changeSpeed: vi.fn(async () => undefined),
  toggleMonitoring: vi.fn(async () => undefined),
  setShowNotes: vi.fn(),
  setShowLyrics: vi.fn(),
  ...overrides,
});

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
};

const mount = (session: ReturnType<typeof makeSession>, exit = vi.fn()) => {
  renderHook(() => useKaraokeShortcuts(session as never, 200, exit));
  return exit;
};

it("plays, pauses, seeks and sets the playback level from the keyboard", () => {
  const session = makeSession();
  mount(session);
  expect(press(" ").defaultPrevented).toBe(true);
  press("k");
  press("ArrowRight");
  press("ArrowLeft", { shiftKey: true });
  press("Home");
  press("ArrowUp");
  press("ArrowDown");
  expect(session.togglePlay).toHaveBeenCalledTimes(2);
  expect(session.seek.mock.calls).toEqual([[35], [15], [0]]);
  expect(session.changeGain.mock.calls).toEqual([["master", 0.85], ["master", 0.75]]);
});

it("changes key, tempo, notes, text and hearing yourself, and leaves with Escape", () => {
  const session = makeSession();
  const exit = mount(session);
  press("]");
  press("[");
  press("+");
  press("-");
  press("n");
  press("T");
  press("m");
  press("Escape");
  expect(session.changeKey.mock.calls).toEqual([[1], [-1]]);
  expect(session.changeSpeed.mock.calls).toEqual([[1.05], [0.95]]);
  expect(session.setShowNotes).toHaveBeenCalledWith(false);
  expect(session.setShowLyrics).toHaveBeenCalledWith(false);
  expect(session.toggleMonitoring).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledOnce();
});

it("obeys room rights and leaves keys to a focused field or slider", () => {
  const session = makeSession({ interactive: false, practiceLocked: true });
  mount(session);
  press("ArrowRight");
  press("]");
  press("+");
  expect(session.seek).not.toHaveBeenCalled();
  expect(session.changeKey).not.toHaveBeenCalled();
  expect(session.changeSpeed).not.toHaveBeenCalled();
  const input = document.createElement("input");
  document.body.append(input);
  press(" ", {}, input);
  expect(session.togglePlay).not.toHaveBeenCalled();
  input.remove();
});
