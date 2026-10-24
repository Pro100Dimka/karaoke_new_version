import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(() => {
    const original = window.desktop!.pythonRequest;
    const scenario = Object.assign(window, {
      libraryDone: false,
      libraryFail: false,
      libraryRevealed: [] as string[],
      libraryWrites: [] as unknown[],
    });
    window.desktop!.pathForFile = () => "E:/CodexTemp/library.advoice.zip";
    window.desktop!.revealInExplorer = async (path) => {
      scenario.libraryRevealed.push(path);
    };
    window.desktop!.pythonRequest = async (request) => {
      const reply = (body: unknown) => ({ status: 200, ok: true, body });
      const action = request.path.match(
        /^\/packages\/library\/(export|import)$/,
      )?.[1];
      if (action) {
        scenario.libraryWrites.push({ action, body: request.body });
        return reply({ jobId: `library-${action}`, state: "Queued" });
      }
      if (request.path.startsWith("/jobs/library-"))
        return reply({
          jobId: request.path.split("/").at(-1),
          state: scenario.libraryFail
            ? "Failed"
            : scenario.libraryDone
              ? "Succeeded"
              : "Running",
          overallProgress: scenario.libraryDone ? 1 : 0.25,
          report: request.path.endsWith("export")
            ? { path: "E:/CodexTemp/exports/library.advoice.zip" }
            : { imported: 2, skipped: 1 },
          error: { code: "PackageInvalid", message: "Archive failed" },
        });
      return original(request);
    };
  });
});

test("library archive exports with progress, reveals the finished file, and imports a picked archive", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(".floatingControls")
    .getByRole("button", { name: "Настройки", exact: true })
    .click();
  await page.getByRole("tab", { name: "AI / Обработка", exact: true }).click();
  const exportButton = page.getByRole("button", {
    name: "Экспорт всей библиотеки",
    exact: true,
  });
  const importButton = page.getByRole("button", {
    name: "Импорт библиотеки",
    exact: true,
  });
  await exportButton.click();
  const progress = page.getByRole("progressbar", {
    name: "Экспорт всей библиотеки",
    exact: true,
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "25");
  await expect(importButton).toBeDisabled();
  expect(await page.evaluate(() => (window as any).libraryRevealed)).toEqual(
    [],
  );
  await page.evaluate(() => {
    (window as any).libraryDone = true;
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryRevealed))
    .toEqual(["E:/CodexTemp/exports/library.advoice.zip"]);
  await expect(exportButton).toBeEnabled();
  await page.evaluate(() => {
    (window as any).libraryDone = false;
  });
  const chooser = page.waitForEvent("filechooser");
  await importButton.click();
  await (
    await chooser
  ).setFiles({
    name: "library.advoice.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("fixture"),
  });
  await expect(
    page.getByRole("progressbar", { name: "Импорт библиотеки", exact: true }),
  ).toHaveAttribute("aria-valuenow", "25");
  await page.evaluate(() => {
    (window as any).libraryDone = true;
  });
  await expect(importButton).toBeEnabled();
  expect(await page.evaluate(() => (window as any).libraryWrites)).toEqual([
    { action: "export" },
    { action: "import", body: { path: "E:/CodexTemp/library.advoice.zip" } },
  ]);
  await expect(
    page.getByText("Добавлено песен: 2. Уже в библиотеке: 1."),
  ).toBeVisible();
});

test("failed library export unlocks the actions and never reveals an unfinished archive", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(".floatingControls")
    .getByRole("button", { name: "Настройки", exact: true })
    .click();
  await page.getByRole("tab", { name: "AI / Обработка", exact: true }).click();
  await page.evaluate(() => {
    (window as any).libraryFail = true;
  });
  const button = page.getByRole("button", {
    name: "Экспорт всей библиотеки",
    exact: true,
  });
  await button.click();
  await expect(page.getByText("Archive failed", { exact: true })).toBeVisible();
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => (window as any).libraryRevealed)).toEqual(
    [],
  );
});
