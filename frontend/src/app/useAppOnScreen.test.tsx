import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppOnScreen } from "./useAppOnScreen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktop");
});

it("keeps animation enabled on a visible detached panel when the main document is hidden", () => {
  let publish!: (visible: boolean) => void;
  Object.assign(window, { desktop: { onAppVisibility: (listener: typeof publish) => {
    publish = listener;
    return vi.fn();
  } } });
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const { result } = renderHook(useAppOnScreen);
  act(() => publish(true));
  expect(result.current).toBe(true);
  act(() => publish(false));
  expect(result.current).toBe(false);
  act(() => publish(true));
  expect(result.current).toBe(true);
});

it("resumes browser decoration after every hide and restore without changing motion preferences", () => {
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const { result } = renderHook(useAppOnScreen);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const value of [true, false]) {
      act(() => {
        hidden = value;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current).toBe(!hidden);
    }
  }
});
