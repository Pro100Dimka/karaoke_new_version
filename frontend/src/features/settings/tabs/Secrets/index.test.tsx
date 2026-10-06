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
    loginKaggle: vi.fn(),
    deployKaggle: vi.fn(),
  },
}));

const relay = {
  key: "AD_VOICE_ROOM_SERVER_RELAY_PORT", group: "room", kind: "port", value: "40000",
  configured: true, state: "valid", message: "Value is valid",
} as const;


const roomPort = {
  key: "AD_VOICE_ROOM_SERVER_PORT", group: "room", kind: "port", value: "8081",
  configured: true, state: "valid", message: "Value is valid",
} as const;

const token = {
  key: "AD_VOICE_AUDD_TOKEN", group: "recognition", kind: "secret", value: "",
  configured: true, state: "valid", message: "Token is valid",
} as const;

const kaggleAccount = {
  key: "KAGGLE_API_TOKEN", group: "kaggle", kind: "secret", value: "",
  configured: false, state: "empty", message: "Value is not configured",
} as const;

describe("environment settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([kaggleAccount, relay]);
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
    vi.mocked(pythonClient.loginKaggle).mockResolvedValue({
      state: "valid", message: "Authenticated",
    });
    vi.mocked(pythonClient.deployKaggle).mockResolvedValue({
      state: "valid",
      message: "Notebook started",
      url: "https://www.kaggle.com/code/singer/ad-voice-gpu",
    });
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

  it("finishes a pending save when the user leaves the ENV tab immediately", async () => {
    const view = render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);
    const input = await screen.findByLabelText("Порт передачи голоса");

    fireEvent.change(input, { target: { value: "41000" } });
    view.unmount();

    await waitFor(
      () => expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledWith(
        "AD_VOICE_ROOM_SERVER_RELAY_PORT", "41000",
      ),
      { timeout: 1500 },
    );
  });

  it("keeps a saved secret when its field is emptied and removes it only on request", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([kaggleAccount, relay, token]);
    vi.mocked(pythonClient.updateEnvironmentSetting).mockResolvedValue({
      ...token, configured: false, state: "empty",
    });
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);
    const field = await screen.findByLabelText("Токен AudD");

    fireEvent.change(field, { target: { value: "x" } });
    fireEvent.change(field, { target: { value: "" } });
    await new Promise(resolve => window.setTimeout(resolve, 600));
    expect(vi.mocked(pythonClient.updateEnvironmentSetting).mock.calls.filter(([key]) => key === "AD_VOICE_AUDD_TOKEN"))
      .toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Удалить сохранённое значение" }));
    await waitFor(() => expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledWith("AD_VOICE_AUDD_TOKEN", ""));
  });

  it("empties a secret field once the new value is saved", async () => {
    vi.mocked(pythonClient.updateEnvironmentSetting).mockResolvedValue({
      ...kaggleAccount, configured: true, state: "unverified",
    });
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);
    const field = await screen.findByLabelText("Токен доступа Kaggle");

    fireEvent.change(field, { target: { value: "personal-kaggle-token" } });

    await waitFor(() => expect(field).toHaveValue(""), { timeout: 1500 });
    expect(field).toHaveAttribute("placeholder", "Сохранено. Введите новое значение, чтобы заменить");
  });

  it("stores the visible Kaggle credential as the account API token", async () => {
    vi.mocked(pythonClient.updateEnvironmentSetting).mockResolvedValue({
      ...kaggleAccount,
      configured: true,
      state: "unverified",
    });
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    fireEvent.change(await screen.findByLabelText("Токен доступа Kaggle"), {
      target: { value: "personal-kaggle-token" },
    });

    await waitFor(
      () => expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledWith(
        "KAGGLE_API_TOKEN",
        "personal-kaggle-token",
      ),
      { timeout: 1500 },
    );
    expect(pythonClient.updateAiProcessingSettings).not.toHaveBeenCalled();
    expect(pythonClient.deployKaggle).not.toHaveBeenCalled();
  });

  it("stops showing a pending status after the Kaggle account token is saved", async () => {
    vi.mocked(pythonClient.updateEnvironmentSetting).mockResolvedValue({
      ...kaggleAccount,
      value: "personal-kaggle-token",
      configured: true,
      state: "unverified",
      message: "Value is saved",
    });
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    fireEvent.change(await screen.findByLabelText("Токен доступа Kaggle"), {
      target: { value: "personal-kaggle-token" },
    });

    const card = screen.getByText("Kaggle GPU").closest(".environmentGroupCard");
    await waitFor(
      () => expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledWith(
        "KAGGLE_API_TOKEN",
        "personal-kaggle-token",
      ),
      { timeout: 1500 },
    );
    await waitFor(() => expect(card).toHaveAttribute("data-state", "unverified"));
  });

  it("does not deploy Kaggle before a song needs remote processing", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      { ...kaggleAccount, configured: true, state: "unverified" },
      relay,
    ]);

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByLabelText("Токен доступа Kaggle")).toBeVisible();
    expect(pythonClient.deployKaggle).not.toHaveBeenCalled();
  });

  it("does not start Kaggle merely by opening ENV settings while local processing is selected", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      { ...kaggleAccount, configured: true, state: "unverified" },
      relay,
    ]);
    vi.mocked(pythonClient.getAiProcessingSettings).mockResolvedValue({
      processingBackend: "Local",
      kaggleConfigured: true,
    });

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByLabelText("Токен доступа Kaggle")).toBeVisible();
    expect(pythonClient.verifyKaggleSettings).not.toHaveBeenCalled();
    expect(pythonClient.deployKaggle).not.toHaveBeenCalled();
  });

  it("reports an unavailable saved notebook without starting it from the settings tab", async () => {
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      { ...kaggleAccount, configured: true, state: "unverified" },
      relay,
    ]);
    vi.mocked(pythonClient.getAiProcessingSettings).mockResolvedValue({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
    });
    vi.mocked(pythonClient.verifyKaggleSettings).mockResolvedValue({
      state: "invalid",
      message: "Kaggle notebook is unavailable",
    });

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    await waitFor(() => expect(pythonClient.verifyKaggleSettings).toHaveBeenCalled());
    await waitFor(() => expect(
      screen.getByText("Kaggle GPU").closest(".environmentGroupCard"),
    ).toHaveAttribute("data-state", "unverified"));
    expect(pythonClient.deployKaggle).not.toHaveBeenCalled();
  });

  it("replaces a stale Kaggle connection error with progress while deployment is running", async () => {
    let finishDeployment!: (value: {
      state: "valid"; message: string; url: string;
    }) => void;
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      { ...kaggleAccount, configured: true, state: "unverified" },
      relay,
    ]);
    vi.mocked(pythonClient.getAiProcessingSettings).mockResolvedValue({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
    });
    vi.mocked(pythonClient.verifyKaggleSettings).mockResolvedValue({
      state: "invalid",
      message: "Could not connect to the Kaggle notebook",
    });
    vi.mocked(pythonClient.deployKaggle).mockImplementation(() => new Promise((resolve) => {
      finishDeployment = resolve;
    }));

    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Развернуть и запустить" }));
    await waitFor(() => expect(pythonClient.deployKaggle).toHaveBeenCalledOnce());
    expect(screen.queryByText("Could not connect to the Kaggle notebook")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Проверка…")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Развёртывание Kaggle" })).toBeVisible();
    expect(screen.getByText("Kaggle запускает GPU-ноутбук")).toBeVisible();
    expect(screen.getByText("Прошло 0:00 · обычно первый запуск занимает 3–10 минут")).toBeVisible();
    finishDeployment({ state: "valid", message: "Notebook started", url: "https://example.gradio.live" });
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("continues one Kaggle deployment instead of restarting it after the tab remounts", async () => {
    let finishDeployment!: (value: {
      state: "valid"; message: string; url: string;
    }) => void;
    vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
      { ...kaggleAccount, configured: true, state: "unverified" },
      relay,
    ]);
    vi.mocked(pythonClient.deployKaggle).mockImplementation(() => new Promise((resolve) => {
      finishDeployment = resolve;
    }));

    const first = render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Развернуть и запустить" }));
    await waitFor(() => expect(pythonClient.deployKaggle).toHaveBeenCalledOnce());
    first.unmount();
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    expect(await screen.findByRole("progressbar", { name: "Развёртывание Kaggle" })).toBeVisible();
    expect(pythonClient.deployKaggle).toHaveBeenCalledOnce();
    finishDeployment({ state: "valid", message: "Notebook started", url: "https://example.gradio.live" });
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("connects the Kaggle account and starts the private GPU notebook", async () => {
    render(<AppProvider><NotificationsProvider><SecretsSettings /></NotificationsProvider></AppProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Войти в Kaggle" }));
    await waitFor(() => expect(pythonClient.loginKaggle).toHaveBeenCalledOnce());
    await waitFor(() => expect(pythonClient.deployKaggle).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Развернуть и запустить" }));
    await waitFor(() => expect(pythonClient.deployKaggle).toHaveBeenCalledTimes(2));
  });

});
