import { expect, test } from '@playwright/test';
import { installDesktopBridge } from './desktopBridge';

test('Library, Karaoke and Editor render without renderer errors and leave screenshots', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) =>
    errors.push(error.stack || `${error.name}: ${error.message}`),
  );
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A&D Voice' })).toBeVisible();
  const library = page.getByRole('list', {
    name: /Библиотека|Library|Бібліотека/i,
  });
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await expect(
    library.getByRole('button', {
      name: /Запустить караоке|Play karaoke|Почати караоке/i,
    }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('library.png') });

  // Filters apply as they change; resetting is a separate, optional action.
  await page
    .getByRole('button', {
      name: /Фильтры и сортировка|Filters and sorting|Фільтри та сортування/i,
    })
    .click();
  const filterPanel = page.getByRole('dialog', {
    name: /Фильтры и сортировка|Filters and sorting|Фільтри та сортування/i,
  });
  await expect(filterPanel).toBeVisible();
  await expect(
    filterPanel.getByRole('button', { name: /Применить|Apply|Застосувати/i }),
  ).toHaveCount(0);
  await expect(
    filterPanel.getByRole('button', { name: /Сбросить|Reset|Скинути/i }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('library-filters.png') });
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(library.getByRole('listitem')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('library-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/#/karaoke/song-1');
  await expect(page.getByRole('region', { name: 'Люди' })).toContainText(
    'Люди',
  );
  await expect(
    page.getByRole('img', { name: /Клавиатура|Keyboard|Клавіатура/i }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('karaoke.png') });

  await page.setViewportSize({ width: 1280, height: 698 });
  await page.goto('/#/editor/song-1');
  const roll = page.getByRole('application', {
    name: /Редактор мелодии|Melody editor|Редактор мелодії/i,
  });
  await expect(roll.getByRole('button', { name: /60/ })).toBeVisible();
  await expect(roll.getByRole('button', { name: /62/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('editor.png') });

  expect(errors).toEqual([]);
});
