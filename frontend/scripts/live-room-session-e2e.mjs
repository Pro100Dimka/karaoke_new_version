// Run after start-multy.bat with AD_VOICE_MULTI_DEBUG=1. Exercises the rendered
// room entry and exit flows in the normal developer and isolated guest windows.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(import.meta.dirname, "..", "..", "artifacts", "room-e2e", `${stamp}-session`);
mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), launch: "start-multy.bat", checks: [] };
const browsers = await Promise.all([9341, 9342].map((port) =>
  chromium.connectOverCDP(`http://127.0.0.1:${port}`)));
const [host, guest] = browsers.map((browser) => browser.contexts()[0].pages()[0]);
const errors = { host: [], guest: [] };
host.on("pageerror", (error) => errors.host.push(String(error)));
guest.on("pageerror", (error) => errors.guest.push(String(error)));

const check = (name, passed, details = {}) => {
  report.checks.push({ name, passed, details });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
};
const shot = async (name) => {
  await host.screenshot({ path: join(out, `${name}-host.png`) });
  await guest.screenshot({ path: join(out, `${name}-guest.png`) });
};
const diagnostics = (page) => page.evaluate(async () => {
  const result = await window.desktop.audioRequest({ command: "GetDiagnostics" });
  if (result.status !== 0) throw new Error(result.text);
  return Object.fromEntries(result.text.split("\n").filter(Boolean).map((line) => {
    const colon = line.indexOf(": ");
    return [line.slice(0, colon), line.slice(colon + 2)];
  }));
});
const enter = async (page, code) => {
  await page.getByRole("button", { name: /Онлайн-комната|Online room/i }).click();
  await page.getByLabel(/Имя|Name/i).fill(code ? "Session Guest" : "Session Host");
  if (code) {
    await page.getByLabel(/Код комнаты|Room code/i).fill(code);
    await page.getByRole("button", { name: /Войти в комнату|Join room/i }).last().click();
  } else {
    await page.getByRole("button", { name: /Создать комнату|Create room/i }).click();
  }
  await page.locator(".roomDock .roomCodeRow strong").waitFor({ timeout: 30_000 });
};

try {
  await shot("00-library");
  await enter(host);
  const code = await host.locator(".roomCodeRow strong").getAttribute("title");
  if (!code) throw new Error("Room code is missing from the rendered room panel");
  report.roomCode = code;
  await enter(guest, code);
  await Promise.all([host, guest].map((page) =>
    page.locator(".roomDock .participant").nth(1).waitFor({ timeout: 30_000 })));
  await shot("01-joined");
  check("host creates and guest joins through the UI", true, { code });
  report.joinedDiagnostics = { host: await diagnostics(host), guest: await diagnostics(guest) };

  await guest.getByRole("button", { name: /Выйти из комнаты|Leave room/i }).click();
  await guest.locator(".roomDock").waitFor({ state: "hidden", timeout: 30_000 });
  await host.locator(".roomDock .participant").nth(1).waitFor({ state: "hidden", timeout: 30_000 });
  await shot("02-guest-left");
  check("guest leaves and host observes departure", true);

  await enter(guest, code);
  await Promise.all([host, guest].map((page) =>
    page.locator(".roomDock .participant").nth(1).waitFor({ timeout: 30_000 })));
  await shot("03-rejoined");
  check("guest can rejoin the same room after leaving", true);

  await host.getByRole("button", { name: /Выйти из комнаты|Leave room/i }).click();
  await host.getByRole("button", { name: /Закрыть комнату|Close room/i }).click();
  await Promise.all([host, guest].map((page) =>
    page.locator(".roomDock").waitFor({ state: "hidden", timeout: 30_000 })));
  await shot("04-closed");
  check("host closes and both windows leave the room", true);
  report.closedDiagnostics = { host: await diagnostics(host), guest: await diagnostics(guest) };
  check("no renderer exceptions", !errors.host.length && !errors.guest.length, errors);
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(error);
  await shot("failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.length === 5 &&
    report.checks.every(({ passed }) => passed) && !report.error;
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), [
    "# Room session UI check",
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Result: ${report.passed ? "PASS" : "FAIL"}`,
    "- Launch: start-multy.bat, normal developer profile and isolated guest",
    "",
    ...report.checks.map(({ name, passed }) => `- ${passed ? "PASS" : "FAIL"}: ${name}`),
    ...(report.error ? ["", `Error: ${report.error}`] : []),
    "",
    "Screenshots and AudioService diagnostics are saved alongside this report.",
  ].join("\n"));
  console.log(`report: ${out}`);
  await Promise.allSettled([host, guest].map((page) =>
    page.evaluate(() => { void window.desktop.close(); })));
  await Promise.all(browsers.map((browser) => browser.close()));
  if (!report.passed) process.exitCode = 1;
}
