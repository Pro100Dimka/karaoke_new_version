import { chromium } from "playwright";
import { clientSongs } from "./smoke-catalog.mjs";

const server = process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";
const roomButton = /Онлайн-комната|Online room|Онлайн-кімната/i;
const playButton = /Запустить караоке|Play karaoke|Запустити караоке/i;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const room = code => fetch(`${server}/rooms/${code}`).then(response => response.json());

const hostBrowser = await chromium.connectOverCDP("http://127.0.0.1:9341");
const guestBrowser = await chromium.connectOverCDP("http://127.0.0.1:9342");
const host = hostBrowser.contexts()[0].pages()[0];
const guest = guestBrowser.contexts()[0].pages()[0];

const openRoom = async () => {
  let code = uuid.exec(await host.locator("body").innerText())?.[0];
  if (!code) {
    await host.getByRole("button", { name: roomButton }).click();
    await host.getByLabel(/Имя|Name|Ім'я/i).fill("Live Host");
    await host.getByRole("button", { name: /Создать комнату|Create room|Створити кімнату/i }).click();
    await host.getByText(uuid).waitFor({ timeout: 15_000 });
    code = uuid.exec(await host.locator("body").innerText())?.[0];
  }
  if (!code) throw new Error("Room code is absent");
  if (!(await guest.locator("body").innerText()).includes(code)) {
    await guest.getByRole("button", { name: roomButton }).click();
    await guest.getByRole("button", { name: /Войти в комнату|Join room|Увійти до кімнати/i }).first().click();
    await guest.getByLabel(/Имя|Name|Ім'я/i).fill("Live Guest");
    await guest.getByLabel(/Код комнаты|Room code|Код кімнати/i).fill(code);
    await guest.getByRole("button", { name: /Войти в комнату|Join room|Увійти до кімнати/i }).last().click();
  }
  return code;
};

const play = async (code, song) => {
  await host.getByRole("textbox", { name: /Название, исполнитель или файл|Search|Назва, виконавець або файл/i }).fill(song.title);
  const card = host.locator(".songCard").filter({ hasText: song.title }).first();
  await card.getByRole("button", { name: playButton }).click();
  await Promise.all([
    host.waitForURL(/#\/karaoke\//, { timeout: 180_000 }),
    guest.waitForURL(/#\/karaoke\//, { timeout: 180_000 }),
  ]);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await room(code)).playbackState === "Playing") break;
    await delay(250);
  }
  await delay(7_000);
  const snapshot = await room(code);
  const inspect = page => page.evaluate(() => {
    const video = document.querySelector("video");
    const time = document.querySelector(".karaokeConsole")?.textContent ?? "";
    return { url: location.href, hasVideo: Boolean(video), videoTime: video?.currentTime ?? null,
      videoReady: video?.readyState ?? null, text: time.slice(0, 300) };
  });
  const result = { song: song.title, playbackState: snapshot.playbackState,
    participants: snapshot.participants.map(person => person.readinessState),
    host: await inspect(host), guest: await inspect(guest) };
  if (result.playbackState !== "Playing") throw new Error(`Room did not start: ${JSON.stringify(result)}`);
  if (!result.host.hasVideo || !result.guest.hasVideo || (result.host.videoReady ?? 0) < 2 || (result.guest.videoReady ?? 0) < 2) {
    throw new Error(`A client has no playable video: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
};

try {
  const code = await openRoom();
  const [hostSongs, guestSongs] = await Promise.all([clientSongs(host), clientSongs(guest)]);
  const guestIds = new Set(guestSongs.map(song => song.songId));
  const candidates = hostSongs.filter(song => song.status === "Ready" && !guestIds.has(song.songId)).slice(0, 2);
  if (candidates.length < 1) throw new Error("A host-only ready song is required");
  await play(code, candidates[0]);
  await host.getByRole("button", { name: /Библиотека|Library|Бібліотека/i }).first().click();
  await Promise.all([host.waitForURL(/#\/$/, { timeout: 60_000 }), guest.waitForURL(/#\/$/, { timeout: 60_000 })]);
  const replay = candidates[1] ?? candidates[0];
  await play(code, replay);
  console.log(JSON.stringify({ ok: true, roomCode: code, songs: [candidates[0].title, replay.title] }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
