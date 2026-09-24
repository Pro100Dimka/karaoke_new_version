import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { desktopClient } from "../../services/desktopClient";
import { KeyboardLightingSettings } from "./KeyboardLightingSettings";

describe("keyboard lighting settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows controls only when a local compatible keyboard is detected", async () => {
    vi.spyOn(desktopClient, "keyboardLightingCapabilities").mockResolvedValue({
      available: true, provider: "OpenRGB", deviceCount: 2,
    });

    render(<AppProvider><KeyboardLightingSettings /></AppProvider>);

    expect(await screen.findByText("Подсветка клавиатуры")).toBeVisible();
    expect(screen.getByText("OpenRGB · клавиатур: 2")).toBeVisible();
  });

  it("stays hidden when no provider is available", async () => {
    vi.spyOn(desktopClient, "keyboardLightingCapabilities").mockResolvedValue({ available: false, deviceCount: 0 });
    render(<AppProvider><KeyboardLightingSettings /></AppProvider>);
    await waitFor(() => expect(desktopClient.keyboardLightingCapabilities).toHaveBeenCalled());
    expect(screen.queryByText("Подсветка клавиатуры")).not.toBeInTheDocument();
  });
});
