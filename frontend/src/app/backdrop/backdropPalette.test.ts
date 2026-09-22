import { describe, expect, it, vi } from "vitest";
import { backdropPalette } from "./backdropPalette";

describe("backdropPalette", () => {
  it("uses the dedicated vivid visualizer colors without changing UI tokens", () => {
    const values: Record<string, string> = {
      "--visualizer-primary": "#ff315f",
      "--visualizer-accent": "#ff8a4c",
      "--color-primary-hover": "#fallback-hover",
      "--color-secondary": "#fallback-secondary",
      "--color-highlight": "#fallback-highlight",
    };
    const styles = {
      getPropertyValue: vi.fn((name: string) => values[name] ?? ""),
    } as unknown as CSSStyleDeclaration;

    expect(backdropPalette(styles)).toEqual({
      primary: "#ff315f",
      primaryHover: "#fallback-hover",
      secondary: "#fallback-secondary",
      accent: "#ff8a4c",
      highlight: "#fallback-highlight",
    });
  });
});
