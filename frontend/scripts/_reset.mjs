import { chromium } from "playwright";
for (const port of [9351, 9352]) {
  const p = (await chromium.connectOverCDP(`http://127.0.0.1:${port}`)).contexts()[0].pages()[0];
  await p.goto(p.url().replace(/#.*$/, "#/"));
  await p.reload();
  await p.waitForTimeout(7000);
  for (let i = 0; i < 3 && await p.locator("dialog[open]").count(); i++) { const b = p.locator("dialog[open]").getByRole("button", { name: /Остановить и сохранить|Выйти/ }); if (await b.count()) await b.first().click(); await p.waitForTimeout(3000); }
  if (!/#\/$/.test(p.url())) { await p.goto(p.url().replace(/#.*$/, "#/")); await p.waitForTimeout(3000); }
  const leave = p.getByRole("button", { name: /Выйти из комнаты/ });
  if (await leave.count()) { await leave.first().click(); await p.waitForTimeout(1500); const ok = p.locator("dialog[open]").getByRole("button", { name: /Выйти|Leave/ }); if (await ok.count()) await ok.first().click(); await p.waitForTimeout(2000); }
  console.log(port, p.url().split("#")[1], "inRoom", await p.getByRole("button", { name: /Выйти из комнаты/ }).count());
}
process.exit(0);
