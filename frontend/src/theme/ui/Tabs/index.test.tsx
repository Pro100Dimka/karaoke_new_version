import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Tabs from ".";

describe("Tabs neon shape", () => {
  it("draws the supplied sloped SVG frame for every reusable tab", () => {
    const { container } = render(
      <Tabs
        value="advanced"
        items={[
          { value: "appearance", label: "Внешний вид" },
          { value: "advanced", label: "Дополнительно" },
        ]}
      />,
    );

    expect(container.querySelectorAll(".ui-tab-shape")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Дополнительно" }))
      .toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll(".ui-tab-shape__glow")).toHaveLength(2);
    expect(container.querySelectorAll(".ui-tab-shape__edge")).toHaveLength(2);
    expect(container.querySelectorAll(".ui-tab-shape__glint")).toHaveLength(2);
    expect(container.querySelectorAll(".ui-tab-shape__floor")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Внешний вид" })).toHaveAttribute("data-edge", "start");
    expect(screen.getByRole("tab", { name: "Дополнительно" })).toHaveAttribute("data-edge", "end");
  });

  it("clips the neon only at the outside edges of the first and last tabs", () => {
    const stylesheet = readFileSync(resolve("src/theme/ui/Tabs/tabs.css"), "utf8");

    expect(stylesheet).toContain('.ui-tab[data-edge="start"] {');
    expect(stylesheet).toContain('.ui-tab[data-edge="end"] {');
    expect(stylesheet).toContain("clip-path: inset(-12px -12px -12px 0)");
    expect(stylesheet).toContain("clip-path: inset(-12px 0 -12px -12px)");
  });
});
