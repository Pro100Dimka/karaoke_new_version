import { test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("settings screenshot", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "test-results/shot-settings.png" });
});
