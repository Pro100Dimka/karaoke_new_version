import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientSongs } from "./smoke-catalog.mjs";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(frontend, "..");
const roomServer = process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";
const portable = process.env.AD_VOICE_SMOKE_PACKAGED_EXE
  ?? path.join(root, "release", "app", "AD Voice", "AD Voice.exe");
const roomButton = /Онлайн-комната|Online room|Онлайн-кімната/i;
const createButton = /Создать комнату|Create room|Створити кімнату/i;
const joinButton = /Войти в комнату|Join room|Увійти до кімнати/i;
const playButton = /Запустить караоке|Play karaoke|Запустити караоке/i;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const mainWindow = async app => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const page = app.windows().find(candidate => !candidate.url().includes("splash.html"));
    if (page) {
      await page.getByRole("button", { name: roomButton }).waitFor({ timeout: 90_000 });
      return page;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("AD Voice main window did not become ready");
};

let hostApp;
let guestApp;
let hostProcess;
let guestProcess;
try {
  hostApp = await electron.launch({ cwd: frontend, args: ["."], env: { ...process.env } });
  guestApp = await electron.launch({ executablePath: portable, env: { ...process.env } });
  hostProcess = hostApp.process();
  guestProcess = guestApp.process();
  const [host, guest] = await Promise.all([mainWindow(hostApp), mainWindow(guestApp)]);
  host.on("console", message => console.log(`[host:${message.type()}] ${message.text()}`));
  guest.on("console", message => console.log(`[guest:${message.type()}] ${message.text()}`));
  host.on("pageerror", error => console.log(`[host:pageerror] ${error.message}`));
  guest.on("pageerror", error => console.log(`[guest:pageerror] ${error.message}`));
  const [hostSongs, guestSongs] = await Promise.all([clientSongs(host), clientSongs(guest)]);
  const guestIds = new Set(guestSongs.map(song => song.songId));
  const songKey = song => `${song.title}\u0000${song.artist}`.toLocaleLowerCase("ru");
  const guestSongKeys = new Set(guestSongs.map(songKey));
  const selected = hostSongs.find(song =>
    song.status === "Ready"
    && !guestIds.has(song.songId)
    && !guestSongKeys.has(songKey(song))
  );
  if (!selected) throw new Error("No ready host-only song exists for the transfer smoke test");

  await host.getByRole("button", { name: roomButton }).click();
  await host.getByLabel(/Имя|Name|Ім'я/i).fill("Smoke Host");
  await host.getByRole("button", { name: createButton }).click();
  await host.getByRole("complementary", { name: roomButton }).waitFor();
  const code = uuid.exec(await host.locator("body").innerText())?.[0];
  if (!code) throw new Error("Created room code was not shown");

  await guest.getByRole("button", { name: roomButton }).click();
  await guest.getByRole("button", { name: joinButton }).first().click();
  await guest.getByLabel(/Имя|Name|Ім'я/i).fill("Smoke Guest");
  await guest.getByLabel(/Код комнаты|Room code|Код кімнати/i).fill(code);
  await guest.getByRole("button", { name: joinButton }).last().click();
  await guest.getByRole("complementary", { name: roomButton }).waitFor();

  await host.getByRole("textbox", { name: /Название, исполнитель или файл|Search|Назва, виконавець або файл/i }).fill(selected.title);
  const hostCard = host.locator(".songCard").filter({ hasText: selected.title }).first();
  const guestCard = guest.locator(".songCard").filter({ hasText: selected.title }).first();
  await hostCard.waitFor({ timeout: 30_000 });
  await hostCard.getByRole("button", { name: playButton }).click();
  await guestCard.waitFor({ timeout: 30_000 });
  await host.waitForURL(new RegExp(`/karaoke/${selected.songId}`), { timeout: 30_000 });
  await new Promise(resolve => setTimeout(resolve, 8_000));
  const roomSnapshot = await fetch(`${roomServer}/rooms/${code}`).then(response => response.json());
  console.log(JSON.stringify({
    playbackState: roomSnapshot.playbackState,
    selectedSongId: roomSnapshot.songId,
    sharedSongOwner: roomSnapshot.sharedSongs?.find(song => song.songId === selected.songId)?.ownerParticipantId,
    guestUrl: guest.url(),
    guestTransferText: (await guest.locator("body").innerText()).split("\n").filter(line => /загруз|transfer|импорт/i.test(line)).slice(-5)
  }));
  await guest.waitForURL(/#\/karaoke\/[^/]+$/, { timeout: 172_000 });

  const importedSongId = decodeURIComponent(new URL(guest.url()).hash.match(/^#\/karaoke\/([^/?#]+)/)?.[1] ?? "");
  const guestSongsAfterImport = await clientSongs(guest);
  const imported = guestSongsAfterImport.find(song => song.songId === importedSongId);
  console.log(JSON.stringify({ guestKaraokeUrl: guest.url(), importedSongId, importedStatus: imported?.status }));
  if (!imported || imported.status !== "Ready") throw new Error("Downloaded project was not imported as Ready");
  if (imported.activeRevision !== selected.activeRevision) throw new Error("Downloaded project revision does not match the room");
  await new Promise(resolve => setTimeout(resolve, 5_000));
  if (!new RegExp(`#/karaoke/${selected.songId}$`).test(host.url())) {
    throw new Error(`Host did not remain in the selected room karaoke: ${host.url()}`);
  }
  if (!new RegExp(`#/karaoke/${importedSongId}$`).test(guest.url())) {
    throw new Error(`Guest did not remain in the downloaded room karaoke: ${guest.url()}`);
  }
  const unavailable = /Сеть недоступна|Network unavailable|Мережа недоступна/i;
  if (unavailable.test(await host.locator("body").innerText()) || unavailable.test(await guest.locator("body").innerText())) {
    throw new Error("A room client reported the network unavailable after a successful transfer");
  }
  await host.getByRole("button", { name: /Библиотека|Library|Бібліотека/i }).first().click();
  await Promise.all([
    host.waitForURL(/index\.html#\/$/, { timeout: 10_000 }),
    guest.waitForURL(/index\.html#\/$/, { timeout: 10_000 })
  ]);
  const exitedRoom = await fetch(`${roomServer}/rooms/${code}`).then(response => response.json());
  if (exitedRoom.songId !== null || exitedRoom.revision !== null) {
    throw new Error("The room song remained selected after the synchronized Back action");
  }
  console.log(JSON.stringify({
    roomCode: code,
    transferredSongId: selected.songId,
    importedSongId,
    title: selected.title,
    synchronizedBack: true
  }));
} finally {
  await Promise.allSettled([guestApp?.close(), hostApp?.close()]);
  guestProcess?.kill();
  hostProcess?.kill();
}
