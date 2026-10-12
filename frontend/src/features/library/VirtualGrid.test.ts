import { act, render } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualGrid, virtualGridLayout } from "./VirtualGrid";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("virtual grid layout", () => {
  it("derives a compact responsive row height from the actual column width", () => {
    expect(virtualGridLayout(900, 255, 16, 187, 1.62)).toEqual({
      columns: 3,
      itemHeight: 179,
    });
  });

  it("uses the fixed fallback before ResizeObserver reports a width", () => {
    expect(virtualGridLayout(0, 255, 16, 187, 1.62)).toEqual({
      columns: 1,
      itemHeight: 187,
    });
  });

  it("repositions rendered rows when width changes without changing the column count", () => {
    let width = 900;
    const resize = new Map<Element, () => void>();
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        resize.set(target, () => {
          const size = [{ inlineSize: width, blockSize: 600 }];
          this.callback([{
            target, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
            contentRect: new DOMRect(0, 0, width, 600),
          }], this);
        });
      }
      unobserve(target: Element) { resize.delete(target); }
      disconnect() { resize.clear(); }
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    const scrollParent = createRef<HTMLDivElement>();
    const items = Array.from({ length: 5000 }, (_, index) => index);
    const view = render(createElement("div", { ref: scrollParent }, createElement(VirtualGrid<number>, {
      items, itemKey: String, itemHeight: 187, itemAspectRatio: 1.62,
      minColumnWidth: 255, gap: 16, scrollParent, label: "Songs", renderItem: String,
    })));
    const grid = view.getByRole("list", { name: "Songs" });
    expect(grid.querySelectorAll(".songGridItem").length).toBeGreaterThan(0);
    expect(grid.querySelectorAll(".songGridItem").length).toBeLessThan(30);
    expect(grid.children[1]).toHaveStyle({ transform: "translateY(195px)" });

    act(() => {
      width = 960;
      for (const notify of resize.values()) notify();
    });

    expect(grid.children[1]).toHaveStyle({ height: "191px", transform: "translateY(207px)" });
    expect(grid).toHaveStyle({ height: `${Math.ceil(items.length / 3) * 207}px` });
  });
});
