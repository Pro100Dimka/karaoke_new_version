import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("Library, Karaoke and Editor render without renderer errors and leave screenshots", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error.stack ?? error)));
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  await page.screenshot({ path: "test-results/shot-library.png" });

  await page.goto("/#/karaoke/song-1");
  await expect(page.locator(".lyrics .current")).toBeVisible();
  await page.screenshot({ path: "test-results/shot-karaoke.png" });

  await page.goto("/#/editor/song-1");
  await expect(page.locator(".noteBox").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shot-editor.png" });

  expect(errors).toEqual([]);
});
