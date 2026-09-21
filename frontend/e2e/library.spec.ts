import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
});

test("library shows the backend song and opens Karaoke with real lyrics", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  await expect(page.getByText("Люди").first()).toBeVisible();

  await page.getByRole("button", { name: /Запустить караоке|Play karaoke|Почати караоке/i }).first().click();

  await expect(page).toHaveURL(/karaoke\/song-1/);
  await expect(page.locator(".lyrics .current")).toContainText("Люди");
});

test("system window buttons stay clickable above an open modal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings|Налаштування/i }).first().click();
  const close = page.getByRole("button", { name: /Закрыть окно|Close window|Закрити вікно/i });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  const topElement = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? "",
    { x: (box?.x ?? 0) + 4, y: (box?.y ?? 0) + 4 }
  );
  expect(topElement).toMatch(/Закрыть окно|Close window|Закрити вікно/i);
});
