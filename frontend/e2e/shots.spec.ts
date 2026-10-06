import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("Library, Karaoke and Editor render without renderer errors and leave screenshots", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error.stack ?? error)));
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  const library = page.getByRole("list", {
    name: /Библиотека|Library|Бібліотека/i,
  });
  await expect(library.getByRole("listitem")).toHaveCount(1);
  await expect(
    library.getByRole("button", {
      name: /Запустить караоке|Play karaoke|Почати караоке/i,
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/shot-library.png" });

  // Filters apply as they change: the panel has no Apply or Reset step.
  await page
    .getByRole("button", {
      name: /Фильтры и сортировка|Filters and sorting|Фільтри та сортування/i,
    })
    .click();
  const filterPanel = page.locator(".libraryFilterPopover");
  await expect(filterPanel).toBeVisible();
  await expect(
    filterPanel.getByRole("button", { name: /Применить|Apply|Застосувати/i }),
  ).toHaveCount(0);
  await expect(
    filterPanel.getByRole("button", { name: /Сбросить|Reset|Скинути/i }),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/shot-library-filters.png" });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(library.getByRole("listitem")).toBeVisible();
  await page.screenshot({ path: "test-results/shot-library-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/#/karaoke/song-1");
  await expect(page.getByRole("region", { name: "Люди" })).toContainText(
    "Люди",
  );
  await expect(
    page.getByRole("img", { name: /Клавиатура|Keyboard|Клавіатура/i }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/shot-karaoke.png" });

  await page.setViewportSize({ width: 1280, height: 698 });
  await page.goto("/#/editor/song-1");
  const roll = page.getByRole("application", {
    name: /Редактор мелодии|Melody editor|Редактор мелодії/i,
  });
  await expect(roll.getByRole("button", { name: /60/ })).toBeVisible();
  await expect(roll.getByRole("button", { name: /62/ })).toBeVisible();
  await page.screenshot({ path: "test-results/shot-editor.png" });

  expect(errors).toEqual([]);
});
