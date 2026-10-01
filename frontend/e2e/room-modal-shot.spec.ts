import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("room modal reference layout", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Онлайн-комната|Online room/i }).click();
  const dialog = page.getByRole("dialog", { name: /Онлайн-комната|Online room/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /Войти по коду|Join by code/i })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel(/Код комнаты|Room code/i)).toBeVisible();
  await dialog.getByLabel(/Имя|Display name/i).fill("bbd");
  await page.screenshot({ path: "test-results/shot-room-modal.png" });
});
