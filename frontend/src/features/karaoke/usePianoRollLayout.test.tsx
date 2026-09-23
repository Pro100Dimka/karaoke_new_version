import { act, renderHook } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { loadPreferences, type PianoRollLayout } from "../../shared/preferences/preferences";
import { usePianoRollLayout } from "./usePianoRollLayout";

const wrapper = ({ children }: { children: ReactNode }) => <AppProvider>{children}</AppProvider>;

const fakeEvent = (clientX: number, clientY = 0) => ({
  button: 0,
  clientX,
  clientY,
  currentTarget: { setPointerCapture: () => undefined },
  stopPropagation: () => undefined
}) as unknown as React.PointerEvent<HTMLDivElement>;

const spanEvent = (clientX: number, clientY = 0) => fakeEvent(clientX, clientY) as unknown as React.PointerEvent<HTMLSpanElement>;

const renderLayout = () =>
  renderHook(
    () => {
      const ref = useRef<HTMLDivElement>(null);
      return usePianoRollLayout(ref);
    },
    { wrapper }
  );

const drag = (
  result: { current: ReturnType<typeof usePianoRollLayout> },
  from: [number, number],
  to: [number, number]
) => {
  act(() => result.current.beginMove(fakeEvent(...from)));
  act(() => result.current.handleMove(fakeEvent(...to)));
  act(() => result.current.handleUp());
};

const requireLayout = (result: { current: ReturnType<typeof usePianoRollLayout> }): PianoRollLayout => {
  const { layout } = result.current;
  expect(layout).not.toBeNull();
  if (!layout) throw new Error("layout unexpectedly null");
  return layout;
};

describe("usePianoRollLayout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // A cramped viewport makes every resize immediately hit the window-edge clamp, which is a separate
    // concern from the anchor math these tests target; a realistic desktop size keeps them independent.
    Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  it("a plain click selects the panel without moving or saving a layout", () => {
    const { result } = renderLayout();
    expect(result.current.active).toBe(false);

    act(() => result.current.beginMove(fakeEvent(100)));
    act(() => result.current.handleMove(fakeEvent(101)));
    act(() => result.current.handleUp());

    expect(result.current.active).toBe(true);
    expect(result.current.layout).toBeNull();
    expect(loadPreferences().pianoRollLayout).toBeNull();
  });

  it("a real drag moves the panel and saves the new layout for next time", () => {
    const { result } = renderLayout();

    drag(result, [100, 50], [160, 90]);

    expect(result.current.layout).toMatchObject({ left: 60, top: 40 });
    expect(loadPreferences().pianoRollLayout).toMatchObject({ left: 60, top: 40 });
  });

  it("resizing from the bottom-right corner grows the panel and clamps it to the minimum size", () => {
    const { result } = renderLayout();

    act(() => result.current.beginResize("se")(spanEvent(0)));
    act(() => result.current.handleMove(fakeEvent(80, 40)));
    act(() => result.current.handleUp());

    expect(result.current.layout?.width).toBeGreaterThan(920);
    expect(result.current.layout?.height).toBeGreaterThan(180);

    act(() => result.current.beginResize("se")(spanEvent(0)));
    act(() => result.current.handleMove(fakeEvent(-2000, -2000)));
    act(() => result.current.handleUp());

    expect(result.current.layout?.width).toBeGreaterThanOrEqual(320);
    expect(result.current.layout?.height).toBeGreaterThanOrEqual(100);
  });

  it("resizing from a single edge only changes that one axis, anchored on the opposite side", () => {
    const { result } = renderLayout();

    // The east edge only grows width; the panel's own left edge (its anchor) never moves.
    act(() => result.current.beginResize("e")(spanEvent(0, 0)));
    act(() => result.current.handleMove(fakeEvent(50, 0)));
    act(() => result.current.handleUp());
    expect(result.current.layout).toMatchObject({ left: 0, width: 970, height: 180 });

    // Away from the window's left edge, so the next resize's anchor math is not itself clamped.
    drag(result, [0, 0], [200, 0]);
    const beforeWest = requireLayout(result);
    const rightEdge = beforeWest.left + beforeWest.width;

    // The west edge grows width by moving further left; the right edge (left + width) stays put.
    act(() => result.current.beginResize("w")(spanEvent(0, 0)));
    act(() => result.current.handleMove(fakeEvent(-30, 0)));
    act(() => result.current.handleUp());
    const afterWest = requireLayout(result);
    expect(afterWest.left + afterWest.width).toBe(rightEdge);
    expect(afterWest.width).toBe(1000);
  });

  it("resizing from the top edge keeps the bottom edge anchored", () => {
    const { result } = renderLayout();
    drag(result, [0, 0], [0, 200]); // away from the window's top edge first

    const beforeNorth = requireLayout(result);
    const bottomEdge = beforeNorth.top + beforeNorth.height;
    act(() => result.current.beginResize("n")(spanEvent(0, 0)));
    act(() => result.current.handleMove(fakeEvent(0, -40)));
    act(() => result.current.handleUp());

    const afterNorth = requireLayout(result);
    expect(afterNorth.height).toBe(220);
    expect(afterNorth.top + afterNorth.height).toBe(bottomEdge);
  });

  it("resizing from a corner changes both axes at once", () => {
    const { result } = renderLayout();
    drag(result, [0, 0], [300, 300]); // away from both window edges first

    act(() => result.current.beginResize("nw")(spanEvent(0, 0)));
    act(() => result.current.handleMove(fakeEvent(-20, -25)));
    act(() => result.current.handleUp());

    expect(result.current.layout).toMatchObject({ left: 280, top: 275, width: 940, height: 205 });
  });

  it("reapplies a previously saved layout on the next session", () => {
    const first = renderLayout();
    drag(first.result, [0, 0], [40, 20]);
    first.unmount();

    const second = renderLayout();
    expect(second.result.current.layout).toMatchObject({ left: 40, top: 20 });
  });
});
