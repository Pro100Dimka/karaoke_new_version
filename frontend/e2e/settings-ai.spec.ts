import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(() => {
    const desktop = window.desktop!;
    const original = desktop.pythonRequest;
    let settings = { processingBackend: "Kaggle", kaggleConfigured: true };
    let root = "E:/CodexTemp/advoice-settings-ai-20261024/data";
    let modelState = "NotInstalled";
    let reads = 0;
    let cancelled = false;
    const scenario = Object.assign(window, {
      aiWrites: [] as unknown[],
      aiReject: false,
      aiKeepDownloading: false,
    });
    desktop.getStorageRoot = async () => root;
    desktop.pickStorageFolder = async () => `${root}-new`;
    desktop.setStorageRoot = async (value) => {
      root = value;
    };
    desktop.pythonRequest = async (request) => {
      const reply = (body: unknown) => ({ status: 200, ok: true, body });
      if (request.path === "/settings") {
        if (request.method === "PATCH") {
          scenario.aiWrites.push(request.body);
          if (scenario.aiReject)
            return {
              status: 503,
              ok: false,
              body: { message: "Save rejected" },
            };
          settings = { ...settings, ...(request.body as object) };
        }
        return reply(settings);
      }
      if (request.path === "/models")
        return reply([
          {
            modelId: "test-model",
            purpose: "ASR",
            version: "1",
            size: 100,
            state: modelState,
            selected: true,
          },
        ]);
      if (request.path.endsWith("/download")) {
        modelState = "Downloading";
        return reply({ jobId: "model-job", state: "Queued" });
      }
      if (request.path === "/jobs/model-job/cancel") {
        cancelled = true;
        modelState = "NotInstalled";
        return reply({});
      }
      if (request.path === "/jobs/model-job") {
        const done = !scenario.aiKeepDownloading && ++reads >= 3;
        if (done) modelState = "Ready";
        return reply({
          jobId: "model-job",
          state: cancelled ? "Cancelled" : done ? "Succeeded" : "Running",
          overallProgress: done ? 1 : 0.5,
        });
      }
      return original(request);
    };
  });
});

const openAi = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  await page
    .locator(".floatingControls")
    .getByRole("button", { name: "Настройки", exact: true })
    .click();
  await page.getByRole("tab", { name: "AI / Обработка", exact: true }).click();
  return page.locator("dialog:modal");
};

test("new AI settings use the common form, save processing and storage, and download models", async ({
  page,
}, testInfo) => {
  const dialog = await openAi(page);
  const backend = dialog.getByRole("button", {
    name: /^Где обрабатывать песни /,
  });
  await expect(backend).toContainText("Kaggle");
  await expect(
    dialog.getByRole("button", { name: "Скачать", exact: true }),
  ).toHaveCount(0);
  await backend.click();
  await page.getByRole("option", { name: /Этот компьютер/ }).click();
  await expect(backend).toContainText("Этот компьютер");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { aiWrites: unknown[] }).aiWrites,
      ),
    )
    .toEqual([{ processingBackend: "Local" }]);
  await dialog
    .getByRole("button", { name: "Выбрать папку данных", exact: true })
    .click();
  await expect(dialog.getByLabel("Папка данных", { exact: true })).toHaveValue(
    /data-new$/,
  );
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await expect(
    dialog.getByText("Готова · 100 B", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Скачать", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-settings.png") });
});

test("new AI settings restore the saved backend when a write fails", async ({
  page,
}) => {
  const dialog = await openAi(page);
  await page.evaluate(() => Object.assign(window, { aiReject: true }));
  const backend = dialog.getByRole("button", {
    name: /^Где обрабатывать песни /,
  });
  await backend.click();
  await page.getByRole("option", { name: /Этот компьютер/ }).click();
  await expect(backend).toContainText("Kaggle");
  await expect(page.getByText(/Save rejected/)).toBeVisible();
});

test("new AI settings can cancel a running model download", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, { aiKeepDownloading: true }),
  );
  const dialog = await openAi(page);
  await dialog
    .getByRole("button", { name: /^Где обрабатывать песни / })
    .click();
  await page.getByRole("option", { name: /Этот компьютер/ }).click();
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Скачать", exact: true }),
  ).toBeVisible();
});
