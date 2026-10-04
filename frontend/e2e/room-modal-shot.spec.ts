import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("room modal offers creating a room and joining one by code", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Онлайн-комната|Online room|Онлайн-кімната/i }).click();
  const dialog = page.getByRole("dialog", { name: /Пойте вместе|Sing together|Співайте разом/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /^(Имя|Name|Ім'я)$/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Создать комнату|Create room|Створити кімнату/i })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /Код комнаты|Room code|Код кімнати/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Войти в комнату|Join room|Увійти в кімнату/i })).toBeVisible();
  await page.screenshot({ path: "test-results/shot-room-modal.png" });
});

test("room modal stays above fixed application chrome when native modal top-layer is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
  });
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Онлайн-комната|Online room|Онлайн-кімната/i }).click();

  const dialog = page.getByRole("dialog", { name: /Пойте вместе|Sing together|Співайте разом/i });
  const create = dialog.getByRole("button", { name: /Создать комнату|Create room|Створити кімнату/i });
  await expect(dialog).toBeVisible();
  await expect(create).toBeVisible();

  const layers = await page.evaluate(() => ({
    dialog: Number.parseInt(getComputedStyle(document.querySelector(".roomEntryDialog")!).zIndex, 10),
    system: Number.parseInt(getComputedStyle(document.querySelector(".titleBar")!).zIndex, 10),
  }));
  expect(layers.dialog).toBeGreaterThan(layers.system);
  await create.click();
});
