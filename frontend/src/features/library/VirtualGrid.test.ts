import { describe, expect, it } from "vitest";
import { virtualGridLayout } from "./VirtualGrid";

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
});
