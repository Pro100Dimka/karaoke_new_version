import { chromium } from "playwright";
for (const port of [9351, 9352]) {
  const p = (await chromium.connectOverCDP(`http://127.0.0.1:${port}`)).contexts()[0].pages()[0];
  const text = (await p.locator("body").innerText()).replace(/\s+/g, " ");
  console.log(port, p.url().split("#")[1], "inRoom", /Выйти из комнаты|Действия комнаты/.test(text), "code", [...new Set((await p.content()).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])].slice(0, 2), "dialogs", await p.locator("dialog[open]").count());
}
process.exit(0);
