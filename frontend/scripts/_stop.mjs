import { chromium } from "playwright";
const p = (await chromium.connectOverCDP("http://127.0.0.1:9351")).contexts()[0].pages()[0];
const s = p.viewportSize() ?? { width: 900, height: 800 };
for (let i = 0; i < 2; i++) { await p.mouse.move(s.width / 2, s.height - 60); await p.mouse.move(s.width / 2 + 5, s.height - 40); await p.waitForTimeout(700); }
await p.getByRole("toolbar").getByRole("button", { name: /^Стоп$/ }).click();
await p.waitForTimeout(4000);
for (let i = 0; i < 3 && await p.locator("dialog[open]").count(); i++) { console.log("dialog:", (await p.locator("dialog[open]").first().innerText()).replace(/\s+/g, " ")); const b = p.locator("dialog[open]").getByRole("button", { name: /Остановить и сохранить|Да|OK/ }); if (await b.count()) await b.first().click(); await p.waitForTimeout(3000); }
console.log(p.url().split("#")[1]);
process.exit(0);
