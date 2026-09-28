import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../../app/AppContext";
import { NotificationsProvider } from "../../../../app/NotificationsProvider";
import { desktopClient } from "../../../../services/desktopClient";
import { pythonClient } from "../../../../services/pythonClient";
import { AiSettings } from ".";

vi.mock("../../../../services/pythonClient", () => ({
  pythonClient: {
    listModels: vi.fn(),
    diagnostics: vi.fn(),
    getAiProcessingSettings: vi.fn(),
    updateAiProcessingSettings: vi.fn(),
  },
}));

vi.mock("../../../../services/desktopClient", () => ({
  desktopClient: {
    setAppIcon: vi.fn(),
    getStorageRoot: vi.fn(),
    pickStorageFolder: vi.fn(),
    setStorageRoot: vi.fn(),
  },
}));

describe("AI processing settings", () => {
  beforeEach(() => {
    vi.mocked(pythonClient.listModels).mockResolvedValue([]);
    vi.mocked(pythonClient.diagnostics).mockResolvedValue({
      storage: { free: 1 },
    } as never);
    vi.mocked(pythonClient.getAiProcessingSettings).mockResolvedValue({
      processingBackend: "Local",
      kaggleConfigured: true,
    });
    vi.mocked(pythonClient.updateAiProcessingSettings).mockResolvedValue({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
    });
    vi.mocked(desktopClient.getStorageRoot).mockResolvedValue(
      "D:/AD Voice/data",
    );
    vi.mocked(desktopClient.pickStorageFolder).mockResolvedValue(
      "E:/Karaoke",
    );
    vi.mocked(desktopClient.setStorageRoot).mockResolvedValue(undefined);
  });

  it("saves the processing backend as soon as the selection changes", async () => {
    render(
      <AppProvider>
        <NotificationsProvider>
          <AiSettings />
        </NotificationsProvider>
      </AppProvider>,
    );
    const select = await screen.findByLabelText("Где обрабатывать песни");

    fireEvent.click(select);
    fireEvent.click(
      await screen.findByRole("option", {
        name: "Kaggle GPU (для слабого ПК)",
      }),
    );

    await waitFor(() =>
      expect(pythonClient.updateAiProcessingSettings).toHaveBeenCalledWith({
        processingBackend: "Kaggle",
      }),
    );
    expect(
      screen.queryByRole("button", { name: /сохранить/i }),
    ).not.toBeInTheDocument();
  });

  it("lets the user select and persist the application data folder", async () => {
    render(
      <AppProvider>
        <NotificationsProvider>
          <AiSettings />
        </NotificationsProvider>
      </AppProvider>,
    );

    expect(await screen.findByLabelText("Папка данных")).toHaveValue(
      "D:/AD Voice/data",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать папку данных" }),
    );

    await waitFor(() =>
      expect(desktopClient.setStorageRoot).toHaveBeenCalledWith("E:/Karaoke"),
    );
    expect(screen.getByLabelText("Папка данных")).toHaveValue("E:/Karaoke");
  });
});
