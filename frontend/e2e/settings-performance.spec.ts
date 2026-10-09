import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("settings avoids full-screen backdrop blur while remaining a modal", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  const dialog = page.locator("dialog.settingsDialog");
  await expect(dialog).toBeVisible();
  const styles = await dialog.evaluate((element) => ({
    backdrop: getComputedStyle(element, "::backdrop").backdropFilter,
    animation: getComputedStyle(element).animationName,
  }));
  expect(styles.backdrop).toBe("none");
  expect(styles.animation).toBe("settings-dialog-in");
});

test("moving across settings does not repaint a window-sized spotlight", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  const surface = await page.locator("dialog.settingsDialog").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--ad-material-bg"),
  );
  expect(surface).not.toContain("26rem circle at");
});

test("decorative waves in settings do not create hundreds of animated stars", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  await page.getByRole("tab", { name: /Ключи ENV|ENV keys/i }).click();
  await expect(page.locator(".settingsDialog .ad-neon-waves-star")).toHaveCount(0);
  await page.getByRole("tab", { name: /Дополнительно|Advanced/i }).click();
  await expect(page.locator(".settingsDialog .ad-neon-waves-star")).toHaveCount(0);
});
