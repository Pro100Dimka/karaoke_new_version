import { expect, test, type Page } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

const send = (page: Page, command: unknown) =>
  page.evaluate(
    (value) => (window as unknown as { e2eShellCommand?: (c: unknown) => void }).e2eShellCommand?.(value),
    command,
  );

test("with updates off the Library offers a new version: install shows the download, dismiss hides it", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(() => {
    const desktop = (window as unknown as { desktop: { installUpdate(): Promise<boolean> } }).desktop;
    desktop.installUpdate = async () => {
      (window as unknown as { installRequested: boolean }).installRequested = true;
      return true;
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();

  await send(page, { type: "updateAvailable", version: "1.2.0" });
  const offer = page.locator(".serviceBanners").getByText(/Доступно обновление A&D Voice 1\.2\.0|A&D Voice 1\.2\.0 is available/);
  await expect(offer).toBeVisible();
  await page.screenshot({ path: "test-results/update-offer.png" });

  await page.getByRole("button", { name: /^(Установить|Install|Встановити)$/ }).click();
  expect(await page.evaluate(() => (window as unknown as { installRequested?: boolean }).installRequested)).toBe(true);
  await send(page, { type: "updateProgress", percent: 42 });
  await expect(page.locator(".serviceBanners")).toContainText("42%");
  await page.screenshot({ path: "test-results/update-downloading.png" });

  // A failed download gives the offer back, with a message.
  await send(page, { type: "updateFailed" });
  await expect(offer).toBeVisible();
  await page.getByRole("button", { name: /^(Отклонить|Dismiss|Відхилити)$/ }).click();
  await expect(offer).toHaveCount(0);
});
