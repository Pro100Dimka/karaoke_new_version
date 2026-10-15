// One-off room driver for the deadline investigation: open|start|library through the rendered UI.
import { chromium } from "playwright";
const [action, arg] = process.argv.slice(2);
const host = (await chromium.connectOverCDP("http://127.0.0.1:9351")).contexts()[0].pages()[0];
const guest = (await chromium.connectOverCDP("http://127.0.0.1:9352")).contexts()[0].pages()[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomButton = /Онлайн-комната|Online room/i;
if (action === "open") {
  for (const page of [host, guest]) await page.goto(page.url().replace(/#.*$/, "#/"));
  await sleep(3000);
  await host.getByRole("button", { name: roomButton }).click();
  await host.getByLabel(/Имя|Name/i).fill("Host ASIO");
  await host.getByRole("button", { name: /Создать комнату|Create room/i }).click();
  await sleep(6000);
  const code = [...new Set((await host.content()).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g))][0];
  await guest.getByRole("button", { name: roomButton }).click();
  await guest.getByRole("button", { name: /Войти в комнату|Join room/i }).first().click();
  await guest.getByLabel(/Имя|Name/i).fill("Laptop Windows");
  await guest.getByLabel(/Код комнаты|Room code/i).fill(code);
  await guest.getByRole("button", { name: /Войти в комнату|Join room/i }).last().click();
  await sleep(6000);
  console.log(code);
} else if (action === "start") {
  if (!/#\/$/.test(host.url())) await host.getByRole("button", { name: /^Библиотека$/ }).first().click();
  await host.waitForURL(/#\/$/, { timeout: 60000 });
  await sleep(1000);
  await host.locator(".songCard").filter({ hasText: arg ?? "Мне 25" }).first()
    .getByRole("button", { name: /Запустить караоке/i }).click();
  await Promise.all([host.waitForURL(/#\/karaoke\//, { timeout: 180000 }), guest.waitForURL(/#\/karaoke\//, { timeout: 180000 })]);
  console.log("started", new Date().toISOString());
} else if (action === "library") {
  const s = host.viewportSize() ?? { width: 900, height: 800 };
  await host.mouse.move(s.width / 2, s.height - 60);
  await sleep(600);
  await host.getByRole("button", { name: /^Библиотека$/ }).first().click();
  await sleep(1500);
  const save = host.locator("dialog[open]").getByRole("button", { name: /Остановить и сохранить/ });
  if (await save.count()) await save.click();
  await Promise.all([host.waitForURL(/#\/$/, { timeout: 60000 }), guest.waitForURL(/#\/$/, { timeout: 60000 })]);
  console.log("library", new Date().toISOString());
}
process.exit(0);
