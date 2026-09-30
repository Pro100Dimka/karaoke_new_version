import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Card from ".";

const cardStyles = readFileSync("src/theme/ui/Card/card.css", "utf8");

describe("Card animated frame", () => {
  it("uses the fitted SVG neon frame with theme-driven warm and cool channels", () => {
    const { container } = render(<Card variant="laser">Content</Card>);
    const frame = container.querySelector(".ui-card__frame.animatedNeonFrame");

    expect(frame).toBeInTheDocument();
    expect(frame?.querySelectorAll(":scope > rect")).toHaveLength(12);
    expect(frame?.querySelectorAll(":scope > .travelling-edge-glint")).toHaveLength(4);
    expect(frame?.querySelector('[data-frame-tone="cool"] stop[offset=".22"]'))
      .toHaveAttribute("stop-color", "var(--frame-cool)");
    expect(frame?.querySelector('[data-frame-tone="warm"] stop[offset=".22"]'))
      .toHaveAttribute("stop-color", "var(--frame-warm)");
    expect(container.querySelector(".ui-card__glow")).not.toBeInTheDocument();
    expect(container.querySelector(".ui-card__edge")).not.toBeInTheDocument();
  });

  it("keeps the shared frame outside the content mask and limits its palette to the primary theme colors", () => {
    const { container } = render(<Card variant="neon">Content</Card>);
    const card = container.querySelector(".ui-card--neon");
    const frame = card?.querySelector(":scope > .ui-card__frame");
    const panel = card?.querySelector(":scope > .ui-card__panel");

    expect(frame).toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(frame?.nextElementSibling).toBe(panel);
    expect(card).toHaveStyle({ overflow: "visible", border: "0", background: "transparent" });
    expect(cardStyles).toMatch(/\.ui-card\.ui-card--neon\s*\{[^}]*overflow:\s*visible;/s);
    expect(cardStyles).toMatch(/\.ui-card__panel\s*\{[^}]*overflow:\s*hidden;/s);
    expect(cardStyles).toContain("--frame-cool: var(--color-primary-strong");
    expect(cardStyles).toContain("--frame-warm: var(--color-primary-hover");
    expect(cardStyles).toContain("var(--color-primary-hover, var(--ui-primary-hover)) 72%");
    expect(cardStyles).not.toContain("--frame-cool: var(--_card-fx-2)");
  });
});
