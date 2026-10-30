import { act, render } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../../../contracts/models";
import { VirtualGrid } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("virtual grid layout", () => {
  it("repositions rendered rows when width changes without changing the column count", () => {
    let width = 900;
    const resize = new Set<() => void>();
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      private notifications = new Map<Element, () => void>();
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const notify = () => {
          const size = [{ inlineSize: width, blockSize: 600 }];
          this.callback([{
            target, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
            contentRect: new DOMRect(0, 0, width, 600),
          }], this);
        };
        this.notifications.set(target, notify);
        resize.add(notify);
      }
      unobserve(target: Element) { const notify = this.notifications.get(target); if (notify) resize.delete(notify); this.notifications.delete(target); }
      disconnect() { for (const target of this.notifications.keys()) this.unobserve(target); }
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    const scrollParent = createRef<HTMLDivElement>();
    const computedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = computedStyle(element);
      style.gridTemplateColumns = "300px 300px 300px";
      return style;
    });
    const items = Array.from({ length: 5000 }, (_, index) => ({ id: String(index), title: String(index) } as SongDto));
    const gridElement = (songs: SongDto[]) => createElement("div", { ref: scrollParent }, createElement(VirtualGrid, {
      items: songs, itemKey: (song) => song.id, scrollParent, label: "Songs", renderItem: (song) => createElement("div", {}, song.title),
    }));
    const view = render(gridElement([]));
    view.rerender(gridElement(items));
    const grid = view.getByRole("list", { name: "Songs" });
    expect(grid.querySelectorAll(".ad-grid > div").length).toBeGreaterThan(0);
    expect(grid.querySelectorAll(".ad-grid > div").length).toBeLessThan(30);
    expect(grid.children[0]).not.toHaveStyle({ height: "187px" });
    expect(grid.querySelector(".ad-grid")?.children).toHaveLength(3);

    act(() => {
      width = 960;
      for (const notify of [...resize]) notify();
    });

    act(() => { for (const notify of [...resize]) notify(); });
    expect(grid.querySelectorAll(".ad-grid > div").length).toBeLessThan(30);
    expect(grid.children[1]).toHaveAttribute("data-index", "1");
    expect(grid.children[1]).toHaveStyle({ transform: "translateY(616px)" });
  });
});
