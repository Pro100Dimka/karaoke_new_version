// Live friends check through the rendered UI of the two windows start-multy.bat opens with
// AD_VOICE_MULTI_DEBUG=1: a friend request by code, accepting it, a declined and an accepted room
// invitation, room history, and a profile photo seen in the room. Writes screenshots and a report
// to artifacts/room-e2e/<timestamp>-social/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(import.meta.dirname, "..", "..", "artifacts", "room-e2e", `${stamp}-social`);
mkdirSync(out, { recursive: true });
const photo = join(import.meta.dirname, "..", "src", "assets", "theme-icons", "green.png");
const report = { startedAt: new Date().toISOString(), checks: [] };

const host = (await chromium.connectOverCDP("http://127.0.0.1:9341")).contexts()[0].pages()[0];
const guest = (await chromium.connectOverCDP("http://127.0.0.1:9342")).contexts()[0].pages()[0];

const shot = async name => {
  await host.screenshot({ path: join(out, `${name}-host.png`) });
  await guest.screenshot({ path: join(out, `${name}-guest.png`) });
};
const check = (name, passed, details = {}) => {
  report.checks.push({ name, passed, details });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details)}`);
};
const friendsCard = page => page.locator(".statCardButton");
const openFriends = async (page, tab) => {
  if (!(await page.getByRole("tab", { name: /Друзья|Friends/ }).count())) await friendsCard(page).click();
  if (tab) await page.getByRole("tab", { name: tab }).click();
};
const closeDialog = page => page.keyboard.press("Escape");
const setName = async (page, name) => {
  await page.evaluate(value => {
    const key = Object.keys(localStorage).find(item => item.endsWith("preferences"));
    if (!key) return;
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...saved, displayName: value }));
  }, name);
};

try {
  await setName(host, "Release Host");
  await setName(guest, "Release Guest");
  await Promise.all([host.reload(), guest.reload()]);
  await Promise.all([friendsCard(host).waitFor({ timeout: 60_000 }), friendsCard(guest).waitFor({ timeout: 60_000 })]);
  await shot("00-library");
  check("the Friends card is in the library header on both", true, {
    host: await friendsCard(host).innerText(), guest: await friendsCard(guest).innerText(),
  });

  // Friends from an earlier run survive restarting the server and both apps; removing one through
  // the window reaches the other app at once.
  await openFriends(guest, /^(Друзья|Friends)$/);
  const kept = guest.locator(".personRow").filter({ hasText: "Release Host" });
  if (await kept.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
    await shot("00-kept");
    check("friends are kept after the server and both apps restart", true, { row: await kept.innerText() });
    await kept.getByRole("button", { name: /Удалить из друзей|Remove from friends/ }).click();
    await guest.getByRole("dialog").last().getByRole("button", { name: /Удалить из друзей|Remove from friends/ }).click();
    await host.waitForFunction(() => /^0/.test(document.querySelector(".statCardButton")?.textContent?.trim() ?? ""), null, { timeout: 10_000 });
    check("removing a friend is seen by the other app at once", true, { host: await friendsCard(host).innerText() });
  }
  await closeDialog(guest);

  // A friend request by code, pushed to the host at once, accepted from the corner alert.
  await openFriends(host, /Заявки|Requests/);
  const code = (await host.locator(".friendCode").first().innerText()).trim();
  await closeDialog(host);
  await openFriends(guest, /Заявки|Requests/);
  await guest.getByLabel(/Код друга|Friend code/).fill(code.toLowerCase());
  await guest.getByRole("button", { name: /Отправить заявку|Send a request/ }).click();
  const alert = host.locator(".socialAlert").filter({ hasText: /Release Guest/ });
  await alert.waitFor({ timeout: 10_000 });
  await shot("01-friend-request");
  check("a friend request by code reaches the other app at once", true, { code });
  await alert.getByRole("button", { name: /Принять|Accept/ }).click();
  await closeDialog(guest);
  await openFriends(guest, /^(Друзья|Friends)$/);
  await guest.locator(".personRow").filter({ hasText: "Release Host" }).waitFor({ timeout: 10_000 });
  const online = await guest.locator(".personRow").filter({ hasText: "Release Host" }).innerText();
  await shot("02-friends");
  check("accepting makes both friends, and the friend shows online", /В сети|Online/.test(online), { row: online });
  await closeDialog(guest);

  // The host opens a room and invites; the guest declines, then accepts the second invitation.
  await host.getByRole("button", { name: /Онлайн-комната|Online room/i }).click();
  await host.getByLabel(/Имя|Name/i).fill("Release Host");
  await host.getByRole("button", { name: /Создать комнату|Create room/i }).click();
  await host.locator(".roomDock").waitFor({ timeout: 20_000 });
  const invite = async () => {
    await openFriends(host, /^(Друзья|Friends)$/);
    const button = host.locator(".personRow").filter({ hasText: "Release Guest" })
      .getByRole("button", { name: /Пригласить в комнату|Invite to the room/ });
    await button.waitFor({ timeout: 10_000 });
    await host.waitForFunction(() => {
      const row = [...document.querySelectorAll(".personRow")].find(item => item.textContent?.includes("Release Guest"));
      return row?.querySelector("button[aria-label^='Пригласить'], button[aria-label^='Invite']:not([disabled])");
    });
    await button.click();
    await closeDialog(host);
  };
  await invite();
  const invitation = guest.locator(".socialAlert").filter({ hasText: /Release Host/ });
  await invitation.waitFor({ timeout: 10_000 });
  await shot("03-invitation");
  await invitation.getByRole("button", { name: /Отклонить|Decline/ }).click();
  const declined = host.locator(".toastLayer").filter({ hasText: /отклонил|declined/ });
  await declined.waitFor({ timeout: 10_000 });
  await shot("04-declined");
  check("a declined invitation is answered to the host", true, { toast: await declined.innerText() });
  await invite();
  await invitation.waitFor({ timeout: 10_000 });
  await invitation.getByRole("button", { name: /Принять|Accept/ }).click();
  await guest.locator(".roomDock .participant").nth(1).waitFor({ timeout: 30_000 });
  await host.locator(".roomDock .participant").nth(1).waitFor({ timeout: 30_000 });
  await shot("05-joined");
  check("an accepted invitation puts the guest into the host's room", true, {
    guestRoom: await guest.locator(".roomDock").innerText(),
  });

  // A profile photo chosen in the settings appears in the other participant's room panel.
  await host.getByRole("button", { name: /Настройки|Settings/ }).last().click();
  await host.locator(".profileSettings input[type=file]").setInputFiles(photo);
  await host.locator(".toastLayer").filter({ hasText: /Фото сохранено|Photo saved/ }).waitFor({ timeout: 15_000 });
  await closeDialog(host);
  const seen = guest.locator(".roomDock .participant").filter({ hasText: "Release Host" }).locator(".personAvatar img");
  await seen.waitFor({ timeout: 15_000 });
  await shot("06-photo");
  check("the host's photo shows in the guest's room panel", true);

  // Room history on the guest lists the room with the host.
  await openFriends(guest, /История комнат|Room history/);
  const stay = guest.locator(".roomStay").first();
  await stay.waitFor({ timeout: 10_000 });
  const stayText = await stay.innerText();
  await shot("07-history");
  check("room history shows the room and who was there", stayText.includes("Release Host"), { stay: stayText });
  await closeDialog(guest);
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(error);
  await shot("99-failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.length > 0 && report.checks.every(item => item.passed) && !report.error;
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${out}`);
  process.exit();
}
