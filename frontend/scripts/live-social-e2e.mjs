// Live friends check through the rendered UI of the two windows start-multy.bat opens with
// AD_VOICE_MULTI_DEBUG=1: a friend request by code, accepting it, a declined and an accepted room
// invitation, room history, and a profile photo seen in the room. Writes screenshots and a report
// to artifacts/room-e2e/<timestamp>-social/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(
  import.meta.dirname,
  "..",
  "..",
  "artifacts",
  "room-e2e",
  `${stamp}-social`,
);
mkdirSync(out, { recursive: true });
const photo = join(
  import.meta.dirname,
  "..",
  "src",
  "assets",
  "theme-icons",
  "green.png",
);
const report = { startedAt: new Date().toISOString(), checks: [] };

const host = (await chromium.connectOverCDP("http://127.0.0.1:9341"))
  .contexts()[0]
  .pages()[0];
const guest = (await chromium.connectOverCDP("http://127.0.0.1:9342"))
  .contexts()[0]
  .pages()[0];

const shot = async (name) => {
  await host.screenshot({ path: join(out, `${name}-host.png`) });
  await guest.screenshot({ path: join(out, `${name}-guest.png`) });
};
const check = (name, passed, details = {}) => {
  report.checks.push({ name, passed, details });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details)}`);
};
const audioDiagnostics = (page) =>
  page.evaluate(async () => {
    const result = await window.desktop.audioRequest({
      command: "GetDiagnostics",
    });
    if (result.status !== 0) throw new Error(result.text);
    return result.text;
  });
const friendsCard = (page) =>
  page.getByRole("button", { name: /Друзья|Friends/ }).first();
const openFriends = async (page, tab) => {
  if (!(await page.getByRole("tab", { name: /Друзья|Friends/ }).count()))
    await friendsCard(page).click();
  if (tab) await page.getByRole("tab", { name: tab }).click();
};
const closeDialog = (page) => page.keyboard.press("Escape");
const setName = async (page, name) => {
  await page.evaluate((value) => {
    const key = Object.keys(localStorage).find((item) =>
      item.endsWith("preferences"),
    );
    if (!key) return;
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...saved, displayName: value }));
  }, name);
};

try {
  await setName(host, "Release Host");
  await setName(guest, "Release Guest");
  await Promise.all([host.reload(), guest.reload()]);
  await Promise.all([
    friendsCard(host).waitFor({ timeout: 60_000 }),
    friendsCard(guest).waitFor({ timeout: 60_000 }),
  ]);
  await shot("00-library");
  check("the Friends card is in the library header on both", true, {
    host: await friendsCard(host).innerText(),
    guest: await friendsCard(guest).innerText(),
  });

  if (process.argv.includes("--create-together-only")) {
    await openFriends(guest, /^(Друзья|Friends)$/);
    const together = guest
      .getByRole("button", {
        name: /Создать комнату вместе|Create a room together/,
      })
      .first();
    await together.waitFor({ timeout: 10_000 });
    await together.click();
    await closeDialog(guest);
    const invitation = host.locator(".socialAlert").first();
    await invitation.waitFor({ timeout: 15_000 });
    await invitation.getByRole("button", { name: /Принять|Accept/ }).click();
    await Promise.all([
      guest
        .locator(".roomDock .participant")
        .nth(1)
        .waitFor({ timeout: 30_000 }),
      host
        .locator(".roomDock .participant")
        .nth(1)
        .waitFor({ timeout: 30_000 }),
    ]);
    await shot("01-create-together");
    const roomText = [
      await guest.locator(".roomDock").innerText(),
      await host.locator(".roomDock").innerText(),
    ];
    check("an outside-room friend can confirm creating a room together", true, {
      roomText,
    });
    check(
      "the inviter is the room host",
      (await guest
        .locator(".roomDock .participant")
        .first()
        .locator(".host-emblem")
        .count()) > 0,
    );
    check(
      "connected room participants do not show Listening",
      !/Слушает|Listening/.test(roomText.join("\n")),
    );
    report.diagnostics = {
      host: await audioDiagnostics(host),
      guest: await audioDiagnostics(guest),
    };
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.every((item) => item.passed);
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(
      join(out, "report.md"),
      [
        "# Create room together — live evidence",
        "",
        `- Started: ${report.startedAt}`,
        `- Finished: ${report.finishedAt}`,
        `- Result: ${report.passed ? "PASS" : "FAIL"}`,
        "- Launch: start-multy.bat (normal developer profile + isolated guest)",
        "",
        ...report.checks.map(
          (item) => `- ${item.passed ? "PASS" : "FAIL"}: ${item.name}`,
        ),
        "",
        "Machine-readable AudioService diagnostics are embedded in `report.json`.",
      ].join("\n"),
    );
    console.log(`report: ${out}`);
    process.exit(report.passed ? 0 : 1);
  }

  // Friends from an earlier run survive restarting the server and both apps; removing one through
  // the window reaches the other app at once.
  await openFriends(guest, /^(Друзья|Friends)$/);
  const kept = guest.locator(".personRow").filter({ hasText: "Release Host" });
  if (
    await kept.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await shot("00-kept");
    check("friends are kept after the server and both apps restart", true, {
      row: await kept.innerText(),
    });
    await kept
      .getByRole("button", { name: /Удалить из друзей|Remove from friends/ })
      .click();
    await guest
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: /Удалить из друзей|Remove from friends/ })
      .click();
    await host.waitForFunction(
      () =>
        /^0/.test(
          document.querySelector(".statCardButton")?.textContent?.trim() ?? "",
        ),
      null,
      { timeout: 10_000 },
    );
    check("removing a friend is seen by the other app at once", true, {
      host: await friendsCard(host).innerText(),
    });
  }
  await closeDialog(guest);

  // A friend request by code, pushed to the host at once, accepted from the corner alert.
  await openFriends(host, /Заявки|Requests/);
  const code = (await host.locator(".friendCode").first().innerText()).trim();
  await closeDialog(host);
  await openFriends(guest, /Заявки|Requests/);
  await guest.getByLabel(/Код друга|Friend code/).fill(code.toLowerCase());
  await guest
    .getByRole("button", { name: /Отправить заявку|Send a request/ })
    .click();
  const alert = host
    .locator(".socialAlert")
    .filter({ hasText: /Release Guest/ });
  await alert.waitFor({ timeout: 10_000 });
  await shot("01-friend-request");
  check("a friend request by code reaches the other app at once", true, {
    code,
  });
  await alert.getByRole("button", { name: /Принять|Accept/ }).click();
  await closeDialog(guest);
  await openFriends(guest, /^(Друзья|Friends)$/);
  await guest
    .locator(".personRow")
    .filter({ hasText: "Release Host" })
    .waitFor({ timeout: 10_000 });
  const online = await guest
    .locator(".personRow")
    .filter({ hasText: "Release Host" })
    .innerText();
  await shot("02-friends");
  check(
    "accepting makes both friends, and the friend shows online",
    /В сети|Online/.test(online),
    { row: online },
  );
  await closeDialog(guest);

  // Two friends outside rooms can create one together with one confirmation. The person who
  // proposed it owns the room, and connected people no longer carry the redundant "Listening"
  // status in the room panel.
  await openFriends(guest, /^(Друзья|Friends)$/);
  const together = guest
    .locator(".personRow")
    .filter({ hasText: "Release Host" })
    .getByRole("button", {
      name: /Создать комнату вместе|Create a room together/,
    });
  await together.click();
  await closeDialog(guest);
  const togetherInvitation = host
    .locator(".socialAlert")
    .filter({ hasText: /Release Guest/ });
  await togetherInvitation.waitFor({ timeout: 15_000 });
  await togetherInvitation
    .getByRole("button", { name: /Принять|Accept/ })
    .click();
  await Promise.all([
    guest.locator(".roomDock .participant").nth(1).waitFor({ timeout: 30_000 }),
    host.locator(".roomDock .participant").nth(1).waitFor({ timeout: 30_000 }),
  ]);
  await shot("03-create-together");
  check("an outside-room friend can confirm creating a room together", true, {
    inviter: await guest.locator(".roomDock").innerText(),
    invited: await host.locator(".roomDock").innerText(),
  });
  check(
    "the inviter is the room host",
    /HOST|ХОСТ|ВЕДУЧ/i.test(await guest.locator(".roomDock").innerText()),
  );
  check(
    "connected room participants do not show Listening",
    !/Слушает|Listening/.test(
      [
        await guest.locator(".roomDock").innerText(),
        await host.locator(".roomDock").innerText(),
      ].join("\n"),
    ),
  );
  await host
    .getByRole("button", { name: /Выйти из комнаты|Leave room/ })
    .click();
  await host
    .locator(".roomDock")
    .waitFor({ state: "detached", timeout: 15_000 });
  await guest
    .getByRole("button", { name: /Выйти из комнаты|Leave room/ })
    .click();
  await guest
    .locator(".roomDock")
    .waitFor({ state: "detached", timeout: 15_000 });

  // The host opens a room and invites; the guest declines, then accepts the second invitation.
  await host
    .getByRole("button", { name: /Онлайн-комната|Online room/i })
    .click();
  await host.getByLabel(/Имя|Name/i).fill("Release Host");
  await host
    .getByRole("button", { name: /Создать комнату|Create room/i })
    .click();
  await host.locator(".roomDock").waitFor({ timeout: 20_000 });
  const invite = async () => {
    await openFriends(host, /^(Друзья|Friends)$/);
    const button = host
      .locator(".personRow")
      .filter({ hasText: "Release Guest" })
      .getByRole("button", { name: /Пригласить в комнату|Invite to the room/ });
    await button.waitFor({ timeout: 10_000 });
    await host.waitForFunction(() => {
      const row = [...document.querySelectorAll(".personRow")].find((item) =>
        item.textContent?.includes("Release Guest"),
      );
      return row?.querySelector(
        "button[aria-label^='Пригласить'], button[aria-label^='Invite']:not([disabled])",
      );
    });
    await button.click();
    await closeDialog(host);
  };
  await invite();
  const invitation = guest
    .locator(".socialAlert")
    .filter({ hasText: /Release Host/ });
  await invitation.waitFor({ timeout: 10_000 });
  await shot("03-invitation");
  await invitation.getByRole("button", { name: /Отклонить|Decline/ }).click();
  const declined = host
    .locator(".toastLayer")
    .filter({ hasText: /отклонил|declined/ });
  await declined.waitFor({ timeout: 10_000 });
  await shot("04-declined");
  check("a declined invitation is answered to the host", true, {
    toast: await declined.innerText(),
  });
  await invite();
  await invitation.waitFor({ timeout: 10_000 });
  await invitation.getByRole("button", { name: /Принять|Accept/ }).click();
  await guest
    .locator(".roomDock .participant")
    .nth(1)
    .waitFor({ timeout: 30_000 });
  await host
    .locator(".roomDock .participant")
    .nth(1)
    .waitFor({ timeout: 30_000 });
  await shot("05-joined");
  check("an accepted invitation puts the guest into the host's room", true, {
    guestRoom: await guest.locator(".roomDock").innerText(),
  });

  // A profile photo chosen in the settings appears in the other participant's room panel.
  await host
    .getByRole("button", { name: /Настройки|Settings/ })
    .last()
    .click();
  await host.locator(".profileSettings input[type=file]").setInputFiles(photo);
  await host
    .locator(".toastLayer")
    .filter({ hasText: /Фото сохранено|Photo saved/ })
    .waitFor({ timeout: 15_000 });
  const locallySavedPhoto = await host.evaluate(() => {
    const key = Object.keys(localStorage).find((item) =>
      item.includes("preferences"),
    );
    const saved = key ? JSON.parse(localStorage.getItem(key) ?? "{}") : {};
    return (
      typeof saved.profilePhoto === "string" &&
      saved.profilePhoto.startsWith("data:image/")
    );
  });
  await closeDialog(host);
  const seen = guest
    .locator(".roomDock .participant")
    .filter({ hasText: "Release Host" })
    .locator(".host-emblem__photo");
  await seen.waitFor({ timeout: 15_000, state: "attached" });
  await guest.waitForFunction(
    () => {
      const host = [
        ...document.querySelectorAll(".roomDock .participant"),
      ].find((item) => item.textContent?.includes("Release Host"));
      return host
        ?.querySelector(".host-emblem__photo")
        ?.getAttribute("href")
        ?.startsWith("data:image/");
    },
    null,
    { timeout: 15_000 },
  );
  await shot("06-photo");
  check(
    "the host's photo is stored with the local profile and shows in the guest's room panel",
    locallySavedPhoto,
  );

  // Room history on the guest lists the room with the host.
  await openFriends(guest, /История комнат|Room history/);
  const stay = guest.locator(".roomStay").first();
  await stay.waitFor({ timeout: 10_000 });
  const stayText = await stay.innerText();
  await shot("07-history");
  check(
    "room history shows the room and who was there",
    stayText.includes("Release Host"),
    { stay: stayText },
  );
  await closeDialog(guest);

  await host.reload();
  await friendsCard(host).waitFor({ timeout: 60_000 });
  await host
    .getByRole("button", { name: /Настройки|Settings/ })
    .last()
    .click();
  await host
    .locator(".profileSettings .personAvatar img")
    .waitFor({ timeout: 15_000 });
  await shot("08-photo-after-reload");
  check("the profile photo is restored after the application UI reloads", true);
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(error);
  await shot("99-failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed =
    report.checks.length > 0 &&
    report.checks.every((item) => item.passed) &&
    !report.error;
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${out}`);
  process.exit();
}
