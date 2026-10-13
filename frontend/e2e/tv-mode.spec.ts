import { expect, test, type Page } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  // Before the bridge: it reads the extra songs while it installs.
  await page.addInitScript(() => {
    (window as unknown as { e2eExtraSongs: string[] }).e2eExtraSongs = ["Вторая"];
  });
  await page.addInitScript(installDesktopBridge);
});

const playButton = (page: Page, title: string) =>
  page
    .getByLabel(`Бумбокс — ${title}`, { exact: true })
    .getByRole("button", { name: /Запустить караоке|Play karaoke|Почати караоке/i });

const reportDisplays = (page: Page, count: number) =>
  page.evaluate(
    (displays) =>
      (window as unknown as { e2eShellCommand?: (c: unknown) => void }).e2eShellCommand?.({
        type: "displays",
        count: displays,
      }),
    count,
  );

test("the whole Karaoke moves to the TV; the laptop keeps the Library with a remote and a queue", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await playButton(page, "Люди").click();
  await expect(page).toHaveURL(/karaoke\/song-1/);
  await expect(page.locator(".karaokePage .lyrics")).toBeVisible({ timeout: 20_000 });

  const tvButton = page.getByRole("button", { name: /^(На ТВ|On TV|На ТБ)$/ });
  // One display: no button in the console.
  await expect(tvButton).toHaveCount(0);
  await reportDisplays(page, 2);
  await page.mouse.move(700, 450);
  await page.mouse.move(720, 460);
  await expect(page.locator(".displayToggles").getByRole("button", { name: /На ТВ/ })).toBeVisible();

  const popup = page.waitForEvent("popup");
  await tvButton.click();
  const tv = await popup;
  // Karaoke (scene, lyrics, console) is on the TV; the laptop is back in the Library, with a remote.
  await expect(tv.locator("html")).toHaveAttribute("data-tv-screen", "");
  await expect(tv.locator(".tvScreen .karaokePage .lyrics")).toBeVisible();
  await expect(tv.locator(".tvScreen .karaokeConsole")).toHaveCount(1);
  await expect(page).not.toHaveURL(/karaoke/);
  await expect(page.locator(".karaokePage")).toHaveCount(0);
  const remote = page.getByRole("region", { name: /Караоке на ТВ|Karaoke on the TV/ });
  await expect(remote).toContainText("Люди");
  // The Library rests: no animated backdrop under it.
  await expect(page.locator(".libraryBackdrop")).toHaveCount(0);
  await tv.screenshot({ path: "test-results/tv-mode-tv.png" });
  await page.screenshot({ path: "test-results/tv-mode-laptop.png" });

  // A song chosen on the laptop waits its turn.
  await playButton(page, "Вторая").click();
  const dialog = page.locator("dialog:modal");
  await expect(dialog).toContainText("Люди");
  await dialog.getByRole("button", { name: /Следующей|Play next/ }).click();
  await expect(remote).toContainText("Вторая");

  // Ending the song on the laptop starts the next one on the TV.
  await remote.getByRole("button", { name: /Закончить песню|End the song/ }).click();
  await expect(remote).toContainText("Вторая", { timeout: 20_000 });
  await expect(remote).not.toContainText(/Следующая|Next:/);
  await expect(tv.locator(".tvScreen .karaokePage")).toHaveCount(1);
  await expect(tv).toHaveTitle("Вторая", { timeout: 20_000 });

  // Back to the laptop: the TV closes and the same song carries on in the app.
  await remote.getByRole("button", { name: /Вернуть на ноутбук|Back to the laptop/ }).click();
  await expect(page).toHaveURL(/karaoke\/song-2/);
  await expect(page.locator(".karaokePage .lyrics")).toBeVisible();
  if (!tv.isClosed()) await tv.waitForEvent("close");

  // Escape on the TV brings Karaoke back as well.
  await page.mouse.move(700, 450);
  await page.mouse.move(720, 470);
  const again = page.waitForEvent("popup");
  await tvButton.click();
  const tvAgain = await again;
  await expect(tvAgain.locator(".tvScreen .karaokePage .lyrics")).toBeVisible();
  await tvAgain.keyboard.press("Escape").catch(() => undefined);
  if (!tvAgain.isClosed()) await tvAgain.waitForEvent("close");
  await expect(page).toHaveURL(/karaoke\/song-2/);
  await expect(page.locator(".karaokePage .lyrics")).toBeVisible();
});
