// Live room check (AGENTS.md room completion gate) through the rendered UI of the two windows that
// start-multy.bat opens with AD_VOICE_MULTI_DEBUG=1. Writes screenshots and machine-readable
// diagnostics of both AudioService processes to artifacts/room-e2e/<timestamp>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { clientSongs } from "./smoke-catalog.mjs";

const server =
  process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(
  import.meta.dirname,
  "..",
  "..",
  "artifacts",
  "room-e2e",
  stamp,
);
mkdirSync(out, { recursive: true });
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const room = (code) =>
  fetch(`${server}/rooms/${code}`).then((response) => response.json());

const hostBrowser = await chromium.connectOverCDP("http://127.0.0.1:9341");
const guestBrowser = await chromium.connectOverCDP("http://127.0.0.1:9342");
const host = hostBrowser.contexts()[0].pages()[0];
const guest = guestBrowser.contexts()[0].pages()[0];
const report = { startedAt: new Date().toISOString(), steps: [], checks: [] };

const diagnostics = async (page) => {
  const response = await page.evaluate(() =>
    window.desktop.audioRequest({ command: "GetDiagnostics" }),
  );
  return Object.fromEntries(
    response.text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(": ");
        return [line.slice(0, at), line.slice(at + 2)];
      }),
  );
};
const shot = async (name) => {
  await host.screenshot({ path: join(out, `${name}-host.png`) });
  await guest.screenshot({ path: join(out, `${name}-guest.png`) });
};
const check = (name, passed, details) => {
  report.checks.push({ name, passed, details });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details)}`);
};
// Song position heard now on each computer, compared at one instant of the shared machine clock.
const syncSample = async () => {
  const [a, b] = await Promise.all([diagnostics(host), diagnostics(guest)]);
  const seconds = (values) =>
    Number(values.PlaybackPresentationPositionFrames || 0) /
    Number(values.RuntimeOutputSampleRate || 1);
  const ticks = (values) => Number(values.MonotonicTicks || 0) / 1e9;
  const hostAt = seconds(a) - ticks(a);
  const guestAt = seconds(b) - ticks(b);
  return { host: a, guest: b, differenceMs: (hostAt - guestAt) * 1000 };
};
const step = async (name, action) => {
  const started = Date.now();
  await action();
  const sample = await syncSample();
  report.steps.push({
    name,
    ms: Date.now() - started,
    differenceMs: sample.differenceMs,
    host: sample.host,
    guest: sample.guest,
  });
  await shot(name);
  return sample;
};

try {
  await shot("00-start");
  // Room: the host creates it, the guest joins by code.
  await host
    .getByRole("button", { name: /Онлайн-комната|Online room/i })
    .click();
  await host.getByLabel(/Имя|Name/i).fill("Release Host");
  await host
    .getByRole("button", { name: /Создать комнату|Create room/i })
    .click();
  await host.getByText(uuid).first().waitFor({ timeout: 20_000 });
  const code = uuid.exec(await host.locator("body").innerText())?.[0];
  await guest
    .getByRole("button", { name: /Онлайн-комната|Online room/i })
    .click();
  await guest
    .getByRole("button", { name: /Войти в комнату|Join room/i })
    .first()
    .click();
  await guest.getByLabel(/Имя|Name/i).fill("Release Guest");
  await guest.getByLabel(/Код комнаты|Room code/i).fill(code);
  await guest
    .getByRole("button", { name: /Войти в комнату|Join room/i })
    .last()
    .click();
  for (
    let attempt = 0;
    attempt < 60 && (await room(code)).participants?.length < 2;
    attempt += 1
  )
    await delay(500);
  report.roomCode = code;
  check("guest joined the room", (await room(code)).participants.length === 2, {
    code,
  });
  await shot("01-room");

  // A song the guest does not have: it is transferred and every participant must be ready first.
  const [hostSongs, guestSongs] = await Promise.all([
    clientSongs(host),
    clientSongs(guest),
  ]);
  const guestIds = new Set(guestSongs.map((song) => song.songId));
  const song =
    hostSongs.find(
      (item) => item.status === "Ready" && !guestIds.has(item.songId),
    ) ?? hostSongs.find((item) => item.status === "Ready");
  report.song = song.title;
  await host
    .getByRole("textbox", { name: /Название, исполнитель или файл|Search/i })
    .fill(song.title);
  await host
    .locator(".songCard")
    .filter({ hasText: song.title })
    .first()
    .getByRole("button", { name: /Запустить караоке|Play karaoke/i })
    .click();
  const readiness = [];
  let playingAt = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await room(code);
    readiness.push({
      t: attempt * 250,
      state: state.playbackState,
      ready: state.participants.map((p) => p.readinessState),
    });
    if (state.playbackState === "Playing") {
      playingAt = attempt * 250;
      break;
    }
    if (attempt === 8) await shot("02-loading");
    // The guest's own different copy of the song is replaced only by the guest's explicit choice.
    const replace = guest.getByRole("button", {
      name: /Заменить версией хоста|Replace with the host/i,
    });
    if (await replace.count()) {
      if (!report.conflictReplaced) await shot("02-conflict");
      // The room panel re-renders with every poll; a click that missed it is simply tried again.
      report.conflictReplaced = await replace
        .first()
        .click({ timeout: 2_000 })
        .then(
          () => true,
          () => report.conflictReplaced ?? false,
        );
    }
    await delay(250);
  }
  report.readiness = readiness;
  const startedEarly = readiness.some(
    (r) => r.state === "Playing" && r.ready.some((state) => state !== "Ready"),
  );
  check(
    "song starts only when every participant is ready",
    playingAt > 0 && !startedEarly,
    { playingAtMs: playingAt, transferred: !guestIds.has(song.songId) },
  );

  // Steady playing: the two timers heard stay together.
  await delay(4_000);
  const playing = [];
  for (let index = 0; index < 10; index += 1) {
    playing.push((await syncSample()).differenceMs);
    await delay(1_000);
  }
  await shot("03-playing");
  const spread = Math.max(...playing.map(Math.abs));
  check("timers heard stay within 2 ms while playing", spread <= 2, {
    differencesMs: playing.map((v) => Number(v.toFixed(2))),
  });

  // Keyboard: Space pauses and resumes, the right arrow seeks, on both computers.
  await host.bringToFront();
  const paused = await step("04-paused", async () => {
    await host.keyboard.press("Space");
    await delay(1_500);
  });
  check(
    "Space pauses the room",
    paused.host.PlaybackState === "4" && paused.guest.PlaybackState === "4",
    {
      host: paused.host.PlaybackState,
      guest: paused.guest.PlaybackState,
      differenceMs: paused.differenceMs,
    },
  );
  const resumed = await step("05-resumed", async () => {
    await host.keyboard.press("Space");
    await delay(3_000);
  });
  check(
    "Space resumes the room in step",
    resumed.host.PlaybackState === "3" &&
      resumed.guest.PlaybackState === "3" &&
      Math.abs(resumed.differenceMs) <= 2,
    { differenceMs: resumed.differenceMs },
  );
  const before =
    Number(resumed.host.PlaybackPositionFrames) /
    Number(resumed.host.RuntimeOutputSampleRate);
  const sought = await step("06-seek", async () => {
    await host.keyboard.press("ArrowRight");
    await delay(3_000);
  });
  const after =
    Number(sought.host.PlaybackPositionFrames) /
    Number(sought.host.RuntimeOutputSampleRate);
  check(
    "the right arrow seeks five seconds, both stay in step",
    after - before > 6 &&
      after - before < 10 &&
      Math.abs(sought.differenceMs) <= 2,
    { movedSeconds: after - before, differenceMs: sought.differenceMs },
  );

  // Voices both ways: packets and levels of each remote voice.
  const voice = await syncSample();
  const remoteOf = (values) =>
    Object.entries(values)
      .filter(([key]) => key.startsWith("RemoteVoiceRms."))
      .map(([, value]) => Number(value));
  check(
    "voice packets flow both ways",
    Number(voice.host.NetworkPacketsReceived) > 0 &&
      Number(voice.guest.NetworkPacketsReceived) > 0,
    {
      hostReceived: voice.host.NetworkPacketsReceived,
      guestReceived: voice.guest.NetworkPacketsReceived,
      hostHears: remoteOf(voice.host),
      guestHears: remoteOf(voice.guest),
    },
  );

  // Back to the library on both.
  await step("07-library", async () => {
    await host
      .getByRole("button", { name: /Библиотека|Library/i })
      .first()
      .click();
    await Promise.all([
      host.waitForURL(/#\/$/, { timeout: 60_000 }),
      guest.waitForURL(/#\/$/, { timeout: 60_000 }),
    ]);
  });
  check(
    "both return to the library",
    host.url().endsWith("#/") && guest.url().endsWith("#/"),
    { host: host.url(), guest: guest.url() },
  );
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed =
    report.checks.length > 0 &&
    report.checks.every((item) => item.passed) &&
    !report.error;
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${out}`);
}
