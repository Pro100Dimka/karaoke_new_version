import { createRequire } from 'node:module';
const require = createRequire('D:/Git/karaoke_new_version/frontend/package.json');
const { chromium } = require('playwright');
const [port = '9341', action = 'snapshot', arg = ''] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
const reveal = async () => {
  await page.mouse.move(viewport.width / 2 + 10, viewport.height - 80);
  await page.mouse.move(viewport.width / 2, viewport.height - 30);
  await page.waitForTimeout(250);
};
if (action === 'confirm-save') {
  await page.locator('dialog[open]').getByRole('button', { name: /^Остановить и сохранить$/ }).click();
} else if (action === 'front') {
  await page.bringToFront();
  const maximize = page.getByRole('button', { name: /^На весь экран$/ });
  if (await maximize.count()) await maximize.click();
  console.log(JSON.stringify({ url: page.url(), visibility: await page.evaluate(() => document.visibilityState) }));
} else if (action === 'done') {
  const done = page.locator('dialog[open]').getByRole('button', { name: /^Готово$/ });
  if (await done.count()) await done.click();
} else if (action === 'close') {
  await page.getByRole('button', { name: /^Закрыть окно$/ }).click();
} else if (action === 'leave') {
  await page.getByRole('button', { name: /^Выйти из комнаты$/ }).click();
} else if (action === 'close-room') {
  await page.getByRole('button', { name: /^Закрыть комнату$/ }).click();
} else if (action === 'create' || action === 'join') {
  await page.getByRole('button', { name: /Онлайн-комната|Online room/i }).click();
  if (action === 'join') await page.getByRole('button', { name: /Войти в комнату|Join room/i }).first().click();
  await page.getByLabel(/Имя|Name/i).fill(action === 'create' ? 'Host ASIO' : 'Laptop Windows');
  if (action === 'join') await page.getByLabel(/Код комнаты|Room code/i).fill(arg);
  await page.getByRole('button', { name: action === 'create' ? /Создать комнату|Create room/i : /Войти в комнату|Join room/i }).last().click();
  await page.locator('.roomDock .roomCodeRow strong').waitFor({ timeout: 30000 });
  console.log(await page.locator('.roomCodeRow strong').getAttribute('title'));
} else if (action === 'start') {
  await page.locator('.songCard').filter({ hasText: arg || 'Мне 25' }).first()
    .getByRole('button', { name: /Запустить караоке/i }).click();
  await page.waitForURL(/#\/karaoke\//, { timeout: 180000 });
  console.log('karaoke', new Date().toISOString());
} else if (action === 'library') {
  await reveal();
  await page.getByRole('button', { name: /^Библиотека$/ }).first().click();
  const save = page.locator('dialog[open]').getByRole('button', { name: /Остановить и сохранить/ });
  if (await save.count()) await save.click();
  await page.waitForURL(/#\/$/, { timeout: 60000 });
} else if (action === 'levels') {
  await reveal();
  for (const [name, key] of Object.entries(JSON.parse(arg))) {
    await page.getByRole('slider', { name, exact: true }).press(key);
  }
} else if (action === 'remote-default') {
  await reveal();
  await page.getByRole('slider', { name: arg, exact: true }).dblclick();
  console.log(await page.getByRole('slider', { name: arg, exact: true }).getAttribute('aria-valuenow'));
} else if (action === 'mic') {
  const name = arg === 'off' ? 'Выключить мой микрофон' : 'Включить мой микрофон';
  const button = page.getByRole('button', { name, exact: true });
  if (await button.count()) await button.press('Enter');
} else if (action === 'begin') {
  await reveal();
  await page.getByRole('button', { name: /^Сначала$/ }).click();
} else if (action === 'snapshot') {
  await reveal();
  if (arg) await page.screenshot({ path: arg, fullPage: true });
  console.log(JSON.stringify({ url: page.url(), text: await page.locator('body').innerText(),
    sliders: await page.getByRole('slider').evaluateAll(items => items.map(e => ({ label: e.getAttribute('aria-label'), value: e.getAttribute('aria-valuenow'), min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax') }))),
    buttons: await page.getByRole('button').evaluateAll(items => items.map(e => ({ text: e.innerText, label: e.getAttribute('aria-label'), title: e.title }))) }));
}
await browser.close();
