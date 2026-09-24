import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("Library, Karaoke and Editor render without renderer errors and leave screenshots", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error.stack ?? error)));
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  const card = page.locator(".songCard").first();
  const equalizer = card.locator(".songCardEqualizer");
  await expect(equalizer).toHaveCSS("position", "absolute");
  await expect(equalizer.locator(".songCoverBars")).toHaveCSS("overflow", "visible");
  await expect(card.locator(".songCardMeta")).toHaveCSS("display", "flex");
  await expect(card.locator(".cardFooter")).not.toHaveCSS("backdrop-filter", "none");
  const artwork = card.locator(".songCardArtwork");
  await expect(artwork).toHaveCSS("opacity", "1");
  const artworkBounds = await artwork.boundingBox();
  const cardDetailsBounds = await card.locator(".songCardDetails").boundingBox();
  const wideCard = await card.boundingBox();
  expect((artworkBounds?.width ?? 0) / (cardDetailsBounds?.width ?? 1)).toBeCloseTo(1, 2);
  expect((wideCard?.width ?? 0) / (wideCard?.height ?? 1)).toBeCloseTo(1.62, 1);
  await page.screenshot({ path: "test-results/shot-library.png" });

  await page.getByRole("button", { name: /Фильтры и сортировка|Filters and sorting|Фільтри та сортування/i }).click();
  const filterPanel = page.locator(".libraryFilterPopover");
  await expect(filterPanel).toBeVisible();
  await expect(filterPanel.getByRole("button", { name: /Применить|Apply|Застосувати/i })).toHaveCount(0);
  await expect(filterPanel.getByRole("button", { name: /Сбросить|Reset|Скинути/i })).toHaveCount(0);
  await page.screenshot({ path: "test-results/shot-library-filters.png" });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 900, height: 800 });
  await expect
    .poll(async () => {
      const bounds = await card.boundingBox();
      return (bounds?.width ?? 0) / (bounds?.height ?? 1);
    })
    .toBeCloseTo(1.62, 1);
  await page.screenshot({ path: "test-results/shot-library-narrow.png" });

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/#/karaoke/song-1");
  await expect(page.locator(".lyrics .current")).toBeVisible();
  await page.screenshot({ path: "test-results/shot-karaoke.png" });

  await page.goto("/#/editor/song-1");
  await expect(page.locator(".noteBox").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shot-editor.png" });

  expect(errors).toEqual([]);
});
