import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
});

test("the Karaoke stage moves to a second screen and comes back", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Запустить караоке|Play karaoke|Почати караоке/i }).first().click();
  await expect(page).toHaveURL(/karaoke\/song-1/);
  await expect(page.locator(".karaokePage .lyrics")).toBeVisible({ timeout: 20_000 });

  const stageButton = page.getByRole("button", { name: /Сцена на второй экран|Stage on the second screen|Сцена на другий екран/i });
  // One display: no button.
  await expect(stageButton).toHaveCount(0);
  // The desktop reports a TV.
  await page.evaluate(() => (window as unknown as { e2eShellCommand?: (c: unknown) => void }).e2eShellCommand?.({ type: "displays", count: 2 }));
  await expect(stageButton).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await stageButton.click();
  const screen = await popupPromise;
  // The stage moved: lyrics on the second screen, a note on the laptop, nothing drawn twice.
  await expect(screen.locator(".stageScreen .lyrics")).toBeVisible();
  await expect(screen.locator("html")).toHaveAttribute("data-stage-screen", "");
  await expect(page.locator(".karaokePage .lyrics")).toHaveCount(0);
  await expect(page.locator(".stageScreenNotice")).toBeVisible();
  await screen.screenshot({ path: "test-results/stage-screen.png" });

  // Escape on the TV brings the stage back.
  // The window closes itself during the key press, which Playwright may report as a closed page.
  await screen.keyboard.press("Escape").catch(() => undefined);
  if (!screen.isClosed()) await screen.waitForEvent("close");
  await expect(page.locator(".karaokePage .lyrics")).toBeVisible();
  await expect(page.locator(".stageScreenNotice")).toHaveCount(0);

  // So does the notice's button.
  const again = page.waitForEvent("popup");
  await stageButton.click();
  await again;
  await page.locator(".stageScreenNotice").getByRole("button").click();
  await expect(page.locator(".karaokePage .lyrics")).toBeVisible();
});
