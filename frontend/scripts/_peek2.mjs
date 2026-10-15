import { chromium } from "playwright";
for (const port of [9351, 9352]) {
  const p = (await chromium.connectOverCDP(`http://127.0.0.1:${port}`)).contexts()[0].pages()[0];
  const d = p.locator("dialog[open]");
  for (let i = 0; i < await d.count(); i++) console.log(port, "dialog:", (await d.nth(i).innerText()).replace(/\s+/g, " ").slice(0, 300));
  const card = await p.locator("text=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/").allInnerTexts();
  console.log(port, "visible codes", card.slice(0, 3));
}
process.exit(0);
