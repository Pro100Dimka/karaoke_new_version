import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("the radio volume popup shows what the station plays", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  const radio = page.getByRole("button", { name: /^(Радио|Radio|Радіо)$/ });
  if ((await radio.getAttribute("aria-pressed")) !== "true") await radio.click();
  await page.evaluate(() => (window as unknown as { e2eShellCommand?: (c: unknown) => void }).e2eShellCommand?.({ type: "radioTrack", artist: "Thomas Lemmer & Setsuna", title: "Juno" }));
  await page.mouse.move(100, 100);
  await radio.hover();
  await expect(page.locator(".radioTrack")).toContainText("Juno");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/radio-track.png", clip: { x: 700, y: 500, width: 500, height: 300 } });
});
