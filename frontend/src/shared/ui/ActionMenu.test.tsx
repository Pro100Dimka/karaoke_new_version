import { fireEvent, render, screen } from "@testing-library/react";
import { Settings2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

describe("ActionMenu", () => {
  it("can render song actions as compact icon buttons in its popover", () => {
    const run = vi.fn();
    render(<ActionMenu iconOnly trigger={({ ref: _ref, ...props }) => <button {...props}>more</button>} items={[{ id: "settings", label: "Настройки", icon: <Settings2 />, run }]} />);
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    const action = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Настройки"]');
    expect(action).not.toBeNull();
    if (!action) throw new Error("Icon action was not rendered");
    expect(action).toHaveClass("ui-icon-button");
    fireEvent.click(action);
    expect(run).toHaveBeenCalledOnce();
  });
});
