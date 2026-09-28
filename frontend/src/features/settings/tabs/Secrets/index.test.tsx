import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../../../app/NotificationsProvider";
import { AppProvider } from "../../../../app/AppContext";
import { pythonClient } from "../../../../services/pythonClient";
import { SecretsSettings } from ".";

vi.mock("../../../../services/pythonClient", () => ({
  pythonClient: {
    listEnvironmentSettings: vi.fn(),
    updateEnvironmentSetting: vi.fn(),
    verifyEnvironmentSetting: vi.fn(),
    getAiProcessingSettings: vi.fn(),
    updateAiProcessingSettings: vi.fn(),
    verifyKaggleSettings: vi.fn(),
  },
}));

const relay = {
  key: "AD_VOICE_ROOM_SERVER_RELAY_PORT", group: "room", kind: "port", value: "40000",
  configured: true, state: "valid", message: "Value is valid",
} as const;

const roomHost = {
  key: "AD_VOICE_ROOM_SERVER_HOST", group: "room", kind: "text", value: "130.61.169.61",
  configured: true, state: "valid", message: "Value is valid",
} as const;

const roomPort = {
  key: "AD_VOICE_ROOM_SERVER_PORT", group: "room", kind: "port", value: "8081",
  configured: true, state: "valid", message: "Value is valid",
} as const;

const token = {
  key: "AD_VOICE_AUDD_TOKEN", group: "recognition", kind: "secret", value: "private-token",
  configured: true, state: "valid", message: "Token is valid",
} as const;

describe("environment settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([relay]);
    vi.mocked(pythonClient.getAiProcessingSettings).mockResolvedValue({
      processingBackend: "Local", kaggleConfigured: false,
    });
    vi.mocked(pythonClient.updateEnvironmentSetting).mockResolvedValue({
      ...relay, value: "41000",
    });
    vi.mocked(pythonClient.verifyEnvironmentSetting).mockResolvedValue(relay);
    vi.mocked(pythonClient.verifyKaggleSettings).mockResolvedValue({
      state: "valid", message: "Kaggle notebook is available",
    });
  });

  it("uses friendly labels and keeps the full JSON available behind a disclosure", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([relay, token]);
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByLabelText("Порт передачи голоса")).toHaveValue("40000");
    expect(screen.getByLabelText("Токен AudD")).toHaveValue("private-token");
    expect(screen.queryByText("Oracle Cloud")).not.toBeInTheDocument();
    expect(screen.getByText("Технический JSON")).toBeVisible();
    const jsonEditor = screen.getByRole("textbox", { name: "Технический JSON", hidden: true });
    expect(jsonEditor).not.toBeVisible();
    fireEvent.click(screen.getByText("Технический JSON"));
    expect(jsonEditor).toBeVisible();
    await waitFor(() => expect((jsonEditor as HTMLTextAreaElement).value).toContain(
      '"AD_VOICE_ROOM_SERVER_RELAY_PORT": "40000"',
    ));
    expect((jsonEditor as HTMLTextAreaElement).value).toContain("private-token");
    expect(document.querySelector(".environmentForm")).toContainElement(screen.getByLabelText("Порт передачи голоса"));
    expect(screen.queryByRole("heading", { name: "Ключи ENV" })).not.toBeInTheDocument();
    const roomCard = screen.getByText("Сервер комнат").closest(".environmentGroupCard");
    const kaggleCard = screen.getByText("Kaggle GPU").closest(".environmentGroupCard");
    expect(roomCard?.parentElement).toHaveStyle({ "--grid-item-column-md": "span 12" });
    expect(kaggleCard?.parentElement).toHaveStyle({ "--grid-item-column-md": "span 6" });
  });

  it("keeps fields and the editable technical JSON synchronized both ways", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([roomPort, relay]);
    vi.mocked(pythonClient.updateEnvironmentSetting).mockImplementation(async (key, value) => ({
      ...(key === roomPort.key ? roomPort : relay), key, value, configured: true, state: "valid",
    }));
    vi.mocked(pythonClient.verifyEnvironmentSetting).mockImplementation(async (key) =>
      key === roomPort.key ? roomPort : relay,
    );
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    fireEvent.click(await screen.findByText("Технический JSON"));
    const editor = screen.getByRole("textbox", { name: "Технический JSON" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain(
      '"AD_VOICE_ROOM_SERVER_RELAY_PORT": "40000"',
    ));

    fireEvent.change(screen.getByLabelText("Порт передачи голоса"), { target: { value: "41000" } });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain(
      '"AD_VOICE_ROOM_SERVER_RELAY_PORT": "41000"',
    ));

    fireEvent.change(editor, { target: { value: JSON.stringify({
      AD_VOICE_ROOM_SERVER_PORT: "8181",
      AD_VOICE_ROOM_SERVER_RELAY_PORT: "42000",
    }, null, 2) } });
    fireEvent.blur(editor);

    await waitFor(() => expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledWith(
      "AD_VOICE_ROOM_SERVER_PORT", "8181",
    ));
    expect(screen.getByLabelText("Порт комнат")).toHaveValue("8181");
    expect(screen.getByLabelText("Порт передачи голоса")).toHaveValue("42000");
  });

  it("persists and verifies a value automatically after it changes", async () => {
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);
    const input = await screen.findByLabelText("Порт передачи голоса");

    fireEvent.change(input, { target: { value: "41000" } });

    await waitFor(
      () => expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledWith(
        "AD_VOICE_ROOM_SERVER_RELAY_PORT", "41000",
      ),
      { timeout: 1500 },
    );
    await waitFor(() => expect(pythonClient.verifyEnvironmentSetting).toHaveBeenCalledWith("AD_VOICE_ROOM_SERVER_RELAY_PORT"));
  });

  it("never shows a success mark for an empty value", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([{
      ...relay, value: "", configured: false, state: "valid",
    }]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    const input = await screen.findByLabelText("Порт передачи голоса");
    const field = input.closest(".ui-field");
    expect(field?.querySelector('[data-state="empty"]')).toBeInTheDocument();
    expect(field?.querySelector('[data-state="valid"]')).not.toBeInTheDocument();
    expect(field).not.toHaveTextContent("Не настроено");
  });

  it("keeps successful fields quiet and only renders actionable errors", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      relay,
      { ...token, state: "invalid", message: "Could not connect to the service" },
    ]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByLabelText("Порт передачи голоса")).toBeVisible();
    expect(screen.queryByText("Готово к работе")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Настроено:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Сейчас не используется")).not.toBeInTheDocument();
    expect(screen.getByText("Could not connect to the service")).toBeVisible();
  });

  it("does not ask users to rewrite the rotating Kaggle share URL", async () => {
    vi.mocked(pythonClient.getAiProcessingSettings).mockResolvedValue({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
      kaggleUrl: "https://expired-session.gradio.live",
      kaggleToken: "private-token",
    });

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByLabelText("Токен доступа Kaggle")).toHaveValue("private-token");
    expect(screen.queryByLabelText("Адрес ноутбука Kaggle")).not.toBeInTheDocument();
  });

  it("hides recognition services when none has a saved value", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      { ...token, value: "", configured: false, state: "empty" },
      {
        key: "AD_VOICE_YOUTUBE_API_KEY", group: "recognition", kind: "secret", value: "",
        configured: false, state: "empty", message: "Value is not configured",
      },
    ]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    await screen.findByRole("region", { name: "Ключи ENV" });
    expect(screen.queryByText("Распознавание музыки")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Токен AudD")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ключ YouTube API")).not.toBeInTheDocument();
  });

  it("does not expose internal runtime paths as user settings", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      {
        key: "AD_VOICE_PYTHON", group: "runtime", kind: "file", value: "C:/runtime/python.exe",
        configured: true, state: "valid", message: "File is valid",
      },
      {
        key: "AD_VOICE_OPENRGB", group: "runtime", kind: "file", value: "",
        configured: false, state: "empty", message: "Value is not configured",
      },
    ]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    await screen.findByRole("region", { name: "Ключи ENV" });
    expect(screen.queryByText("Компоненты приложения")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Python")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("OpenRGB")).not.toBeInTheDocument();
  });

  it("shows the local SSH files required to update Room Server", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      {
        key: "AD_VOICE_ROOM_SERVER_SSH_KEY", group: "deployment", kind: "file", value: "D:/secrets/room_server",
        configured: true, state: "valid", message: "File is valid",
      },
      {
        key: "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS", group: "deployment", kind: "file", value: "D:/secrets/known_hosts",
        configured: true, state: "valid", message: "File is valid",
      },
      {
        key: "AD_VOICE_ROOM_SERVER_SSH_USER", group: "deployment", kind: "text", value: "ubuntu",
        configured: true, state: "valid", message: "Value is valid",
      },
    ]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByText("Обновление Room Server")).toBeVisible();
    expect(screen.getByLabelText("Приватный SSH-ключ")).toHaveValue("D:/secrets/room_server");
    expect(screen.getByLabelText("Файл known_hosts")).toHaveValue("D:/secrets/known_hosts");
    expect(screen.getByLabelText("SSH-пользователь")).toHaveValue("ubuntu");
  });

  it("shows one server address followed by the room and voice ports", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([roomHost, roomPort, relay]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    const address = await screen.findByLabelText("Адрес сервера");
    expect(address).toHaveValue("130.61.169.61");
    expect(screen.queryByLabelText("Адрес сервера комнат")).not.toBeInTheDocument();
    expect(address.closest(".ui-get-form-cell")).toHaveStyle({
      "--grid-item-column-md": "span 6",
    });
    expect(screen.getByLabelText("Порт комнат").closest(".ui-get-form-cell")).toHaveStyle({
      "--grid-item-column-md": "span 3",
    });
    expect(screen.getByLabelText("Порт передачи голоса").closest(".ui-get-form-cell")).toHaveStyle({
      "--grid-item-column-md": "span 3",
    });
  });
});
