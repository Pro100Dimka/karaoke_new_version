import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { analyzeRoomAudioGaps, maximumActiveLateCutDelta, phaseAtSecond, roomE2eEndpoint, roomE2eLiveDelay, roomE2eScenario, roomE2eTransportOnly, toneContinuity, toneLevel, toneState, validateNegotiation } from "./multi-electron-room-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const frontendRoot = path.join(root, "frontend");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeSilenceWav = async (file, seconds, rate = 48_000) => {
  const dataBytes = seconds * rate * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  await fs.writeFile(file, bytes);
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifacts = path.join(root, "artifacts", "room-e2e", `${stamp}-multi-electron-live`);
await fs.mkdir(artifacts, { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const endpoint = roomE2eEndpoint(process.argv.slice(2));
const transportOnly = roomE2eTransportOnly(process.argv.slice(2));
const httpPort = endpoint.external ? endpoint.httpPort : await freePort();
const relayPort = endpoint.external ? endpoint.relayPort : await freePort();
const apiBase = endpoint.external ? endpoint.apiBase : `http://127.0.0.1:${httpPort}`;
const relayHost = endpoint.external ? endpoint.host : "127.0.0.1";
const serverData = endpoint.external ? null : await fs.mkdtemp(path.join(os.tmpdir(), "ad-voice-electron-room-e2e-"));
const python = path.join(root, "python", ".venv", "Scripts", "python.exe");
const roomServer = endpoint.external ? null : spawn(python, ["-m", "backend.room_server_main"], {
  cwd: path.join(root, "python"), windowsHide: true,
  env: { ...process.env, PYTHONPATH: path.join(root, "python"),
    AD_VOICE_ROOM_SERVER_PORT: String(httpPort), AD_VOICE_ROOM_SERVER_RELAY_PORT: String(relayPort),
    AD_VOICE_ROOM_SERVER_DATA: serverData },
});
let serverLog = "";
roomServer?.stdout.on("data", chunk => { serverLog += chunk; });
roomServer?.stderr.on("data", chunk => { serverLog += chunk; });

const api = async (route, options) => {
  const response = await fetch(`${apiBase}${route}`, {
    ...options, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${route}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
};
for (let attempt = 0; attempt < 100; attempt++) {
  try { await api("/health/ready"); break; }
  catch (error) { if (attempt === 99) throw error; await wait(100); }
}

const launcherEnv = {
  ...process.env,
  AD_VOICE_MULTI_DEBUG: "1", AD_VOICE_MULTI_E2E: "1", AD_VOICE_ROOM_E2E: "1",
  AD_VOICE_ROOM_SERVER: apiBase,
  AD_VOICE_ROOM_SERVER_HOST: relayHost, AD_VOICE_ROOM_SERVER_PORT: String(httpPort),
  AD_VOICE_ROOM_SERVER_RELAY_PORT: String(relayPort),
};
const launcher = spawn("cmd.exe", ["/d", "/c", path.join(root, "start-multy.bat")], {
  cwd: root, windowsHide: true, env: launcherEnv,
});
let launcherLog = "";
const electronPids = [];
const collectLauncher = chunk => {
  const text = chunk.toString(); launcherLog += text;
  for (const match of text.matchAll(/PID\s+(\d+)/g)) electronPids.push(Number(match[1]));
};
launcher.stdout.on("data", collectLauncher);
launcher.stderr.on("data", collectLauncher);

const connect = async port => {
  for (let attempt = 0; attempt < 240; attempt++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await wait(500); }
  }
  throw new Error(`Electron DevTools did not open on ${port}\n${launcherLog}`);
};
const appPage = async browser => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const pages = browser.contexts().flatMap(context => context.pages())
      .filter(page => !page.isClosed() && !page.url().startsWith("devtools:"));
    const page = pages.at(-1);
    if (page) {
      try {
        await page.getByRole("button", { name: roomButton }).waitFor({ timeout: 500 });
        await wait(500);
        if (!page.isClosed()) return page;
      }
      catch { /* Electron may replace its first bootstrap page. */ }
    }
    await wait(250);
  }
  throw new Error("Electron application page did not become stable");
};
const audio = (page, command, args) => page.evaluate(async ({ command, args }) => {
  const result = await window.desktop.audioRequest({ command, args });
  if (result.status !== 0) throw new Error(`${command}: ${result.text}`);
  return result.text;
}, { command, args });
const diagnostics = async page => Object.fromEntries((await audio(page, "GetDiagnostics"))
  .split(/\r?\n/).filter(Boolean).map(line => {
    const index = line.indexOf(":");
    return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const roomButton = /Онлайн-комната|Online room|Онлайн-кімната/i;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const openRoom = async (host, guest) => {
  await host.getByRole("button", { name: roomButton }).click();
  await host.getByRole("tab", { name: /Создать комнату|Create room|Створити кімнату/i }).click();
  await host.getByLabel(/Имя|Name|Ім'я/i).fill("E2E Host");
  await host.getByRole("button", { name: /Создать комнату|Create room|Створити кімнату/i }).click();
  await host.locator(".roomHead").waitFor({ timeout: 30_000 });
  const title = await host.locator(".roomCodeRow strong").getAttribute("title");
  const code = uuid.exec(title ?? await host.locator("body").innerText())?.[0];
  if (!code) throw new Error("Created room code was not rendered");
  await guest.getByRole("button", { name: roomButton }).click();
  await guest.getByRole("button", { name: /Войти в комнату|Join room|Увійти до кімнати/i }).first().click();
  await guest.getByLabel(/Имя|Name|Ім'я/i).fill("E2E Guest");
  await guest.getByLabel(/Код комнаты|Room code|Код кімнати/i).fill(code);
  await guest.getByRole("button", { name: /Войти в комнату|Join room|Увійти до кімнати/i }).last().click();
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await api(`/rooms/${code}`);
    if (state.participants?.length === 2) return code;
    await wait(250);
  }
  throw new Error("Both Electron clients did not join the room");
};
const number = value => Number(value ?? 0) || 0;
const wav = async file => {
  const bytes = await fs.readFile(file); let offset = 12, format = 0, channels = 0, rate = 0, bits = 0, data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") { format = bytes.readUInt16LE(offset + 8); channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22); }
    if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  if (!data || !channels || !rate) throw new Error(`Invalid WAV: ${file}`);
  const width = bits / 8, frames = data.length / width / channels, mono = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const at = (frame * channels + channel) * width;
    mono[frame] += (format === 3 && bits === 32 ? data.readFloatLE(at) : data.readInt16LE(at) / 32768) / channels;
  }
  return { rate, mono };
};
let hostBrowser, guestBrowser, host, guest, roomCode, report;
const liveDelayMs = roomE2eLiveDelay(process.argv.slice(2));
const scenario = roomE2eScenario(process.argv.slice(2));
const hostWav = path.join(artifacts, "host-master.wav"), guestWav = path.join(artifacts, "guest-master.wav");
const personalControlsWav = path.join(artifacts, "host-personal-controls.wav");
try {
  [hostBrowser, guestBrowser] = await Promise.all([connect(9341), connect(9342)]);
  [host, guest] = await Promise.all([appPage(hostBrowser), appPage(guestBrowser)]);
  await Promise.all([host.waitForLoadState("domcontentloaded"), guest.waitForLoadState("domcontentloaded")]);
  roomCode = await openRoom(host, guest);
  await Promise.all([host.screenshot({ path: path.join(artifacts, "host-joined.png") }), guest.screenshot({ path: path.join(artifacts, "guest-joined.png") })]);
  await Promise.all([
    audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: 0, requestedDelayMs: 160 }),
    audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: 160 }),
  ]);
  let state;
  for (let attempt = 0; attempt < 120; attempt++) {
    state = await api(`/rooms/${roomCode}`);
    if (state.participants?.length === 2 &&
        state.participants.every(item => item.voiceTimingReady && item.voiceLatencyMs >= 159)) break;
    await wait(250);
  }
  if (!state.participants?.every(item => item.voiceTimingReady && item.voiceLatencyMs >= 159))
    throw new Error(`Electron clients did not publish the diagnostic 160 ms route: ${JSON.stringify(state.participants)}`);
  const fallbackDiagnostics = await Promise.all([diagnostics(host), diagnostics(guest)]);
  const participants = state.participants;
  const fallbackNegotiation = {
    publishedA: number(participants[0]?.voiceLatencyMs), publishedB: number(participants[1]?.voiceLatencyMs),
    eligibleA: participants[0]?.voiceEligible, eligibleB: participants[1]?.voiceEligible,
    selected: number(state.roomPlayoutDelayMs),
    selectionReason: state.roomPlayoutDelayReason ?? (participants.some(item => item.voiceEligible) ? "measured-eligible-route" : "bounded-no-eligible-route"),
    appliedA: number(fallbackDiagnostics[0].RoomPlayoutDelayFrames) * 1000 / number(fallbackDiagnostics[0].RuntimeOutputSampleRate),
    appliedB: number(fallbackDiagnostics[1].RoomPlayoutDelayFrames) * 1000 / number(fallbackDiagnostics[1].RuntimeOutputSampleRate),
  };
  validateNegotiation(fallbackNegotiation);
  await Promise.all([
    audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: 0, requestedDelayMs: liveDelayMs }),
    audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: liveDelayMs }),
  ]);
  for (let attempt = 0; attempt < 120; attempt++) {
    state = await api(`/rooms/${roomCode}`);
    if (state.participants?.length === 2 &&
        state.participants.every(item => item.voiceTimingReady && item.voiceEligible && item.voiceLatencyMs === liveDelayMs)) break;
    await wait(250);
  }
  if (!state.participants?.every(item => item.voiceEligible && item.voiceLatencyMs === liveDelayMs))
    throw new Error(`Electron clients did not enter the eligible live phase: ${JSON.stringify(state.participants)}`);
  const liveDiagnostics = await Promise.all([diagnostics(host), diagnostics(guest)]);
  const liveNegotiation = {
    publishedA: number(state.participants[0]?.voiceLatencyMs), publishedB: number(state.participants[1]?.voiceLatencyMs),
    eligibleA: state.participants[0]?.voiceEligible, eligibleB: state.participants[1]?.voiceEligible,
    selected: number(state.roomPlayoutDelayMs), selectionReason: "measured-eligible-route",
    appliedA: number(liveDiagnostics[0].RoomPlayoutDelayFrames) * 1000 / number(liveDiagnostics[0].RuntimeOutputSampleRate),
    appliedB: number(liveDiagnostics[1].RoomPlayoutDelayFrames) * 1000 / number(liveDiagnostics[1].RuntimeOutputSampleRate),
  };
  validateNegotiation(liveNegotiation);
  if (liveNegotiation.selected !== liveDelayMs)
    throw new Error(`Production negotiation selected ${liveNegotiation.selected} ms instead of ${liveDelayMs} ms`);
  const negotiation = { fallback: fallbackNegotiation, live: liveNegotiation };

  // Exercise personal controls in the local release gate. The external-network soak deliberately
  // isolates transport cadence and skips this already-covered UI/PCM assertion.
  let personalControlLevels = null;
  if (!endpoint.external && !transportOnly) {
    await Promise.all([
      audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: 0, requestedDelayMs: liveDelayMs }),
      audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0.1, requestedDelayMs: liveDelayMs }),
    ]);
    await audio(host, "PrepareRecording", { id: "multi-e2e-personal-controls", path: personalControlsWav, tap: "master" });
    await audio(host, "StartRecording");
    const guestCard = host.locator(".roomPerson").filter({ hasText: "E2E Guest" });
    const guestVolume = guestCard.getByRole("slider", { name: /Громкость.*E2E Guest|E2E Guest volume|Гучність.*E2E Guest/i });
    await guestVolume.waitFor({ timeout: 10_000 });
    await wait(2_000);
    await guestVolume.press("Home");
    for (let step = 0; step < 25; step++) await guestVolume.press("ArrowUp");
    await wait(2_000);
    await guestVolume.press("Home");
    for (let step = 0; step < 100; step++) await guestVolume.press("ArrowUp");
    await wait(2_000);
    const muteGuest = guestCard.getByRole("button", { name: /Заглушить E2E Guest у меня|Mute E2E Guest for me|Заглушити E2E Guest у мене/i });
    await muteGuest.click();
    await wait(2_000);
    await guestCard.getByRole("button", { name: /Снова слышать E2E Guest|Hear E2E Guest again|Знову чути E2E Guest/i }).click();
    await wait(2_000);
    await audio(host, "StopRecording");
    const personalControlsAudio = await wav(personalControlsWav);
    personalControlLevels = {
      baseline: toneLevel(personalControlsAudio.mono, personalControlsAudio.rate, 941, 0.5, 1.5),
      quiet: toneLevel(personalControlsAudio.mono, personalControlsAudio.rate, 941, 2.5, 3.5),
      restored: toneLevel(personalControlsAudio.mono, personalControlsAudio.rate, 941, 4.5, 5.5),
      muted: toneLevel(personalControlsAudio.mono, personalControlsAudio.rate, 941, 6.5, 7.5),
      unmuted: toneLevel(personalControlsAudio.mono, personalControlsAudio.rate, 941, 8.5, 9.5),
    };
    if (personalControlLevels.baseline < 0.005 ||
      personalControlLevels.quiet > personalControlLevels.restored * 0.45 ||
      personalControlLevels.quiet < personalControlLevels.restored * 0.1 ||
      personalControlLevels.restored < personalControlLevels.baseline * 0.7 ||
      personalControlLevels.muted > personalControlLevels.baseline * 0.1 ||
      personalControlLevels.unmuted < personalControlLevels.baseline * 0.7)
      throw new Error(`Personal volume/mute did not reach final PCM: ${JSON.stringify(personalControlLevels)}`);
  }

  await Promise.all([
    audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: 0, requestedDelayMs: liveDelayMs, resetLateCutSeries: true }),
    audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: liveDelayMs, resetLateCutSeries: true }),
  ]);
  if (scenario.name === "seek") {
    const seekSong = path.join(artifacts, "seek-silence.wav");
    await writeSilenceWav(seekSong, scenario.durationSeconds + 30);
    await Promise.all([
      audio(host, "LoadSong", { instrumental: seekSong }),
      audio(guest, "LoadSong", { instrumental: seekSong }),
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      const states = await Promise.all([diagnostics(host), diagnostics(guest)]);
      if (states.every(value => ["Ready", "Paused", "2", "4"].includes(value.PlaybackState))) break;
      if (attempt === 99) throw new Error(`Seek fixture did not load: ${states.map(value => value.PlaybackState)}`);
      await wait(100);
    }
    const clocks = await Promise.all([diagnostics(host), diagnostics(guest)]);
    const startAtTicks = Math.max(...clocks.map(value => number(value.MonotonicTicks))) + 2_000_000_000;
    await Promise.all([
      audio(host, "Play", { context: "karaoke", startAtTicks, frame: 0 }),
      audio(guest, "Play", { context: "karaoke", startAtTicks, frame: 0 }),
    ]);
  }
  await Promise.all([
    audio(host, "PrepareRecording", { id: "multi-e2e-host", path: hostWav, tap: "master" }),
    audio(guest, "PrepareRecording", { id: "multi-e2e-guest", path: guestWav, tap: "master" }),
  ]);
  await Promise.all([audio(host, "StartRecording"), audio(guest, "StartRecording")]);
  const startClock = performance.now();
  const samples = [];
  const seekAtSecond = 60;
  for (let second = 0; second < scenario.durationSeconds; second++) {
    const phase = scenario.name === "standard" ? phaseAtSecond(second) : "BOTH";
    const [gainA, gainB] = toneState(phase);
    if (phase === "RECONNECT_B") {
      await guest.evaluate(() => window.roomE2eReconnectVoiceSession?.());
      await audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: liveDelayMs });
      await host.screenshot({ path: path.join(artifacts, "reconnect.png") });
    }
    if (scenario.name === "standard" && second === 35) await Promise.all([
      audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: 0, requestedDelayMs: liveDelayMs, resetLateCutSeries: true }),
      audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: liveDelayMs, resetLateCutSeries: true }),
    ]);
    if (scenario.name === "seek" && second === seekAtSecond) {
      const runtime = await diagnostics(host);
      const frame = Math.round(5 * number(runtime.RuntimeOutputSampleRate));
      await Promise.all([audio(host, "Pause"), audio(guest, "Pause")]);
      await Promise.all([
        audio(host, "Seek", { context: "karaoke", frame }),
        audio(guest, "Seek", { context: "karaoke", frame }),
      ]);
      await Promise.all([audio(host, "Resume", { context: "karaoke" }), audio(guest, "Resume", { context: "karaoke" })]);
    }
    await Promise.all([
      audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: gainA, requestedDelayMs: liveDelayMs }),
      audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: gainB, requestedDelayMs: liveDelayMs }),
    ]);
    const nextTick = startClock + (second + 1) * 1000;
    await wait(Math.max(0, nextTick - performance.now()));
    const [a, b] = await Promise.all([diagnostics(host), diagnostics(guest)]);
    samples.push({ second, phase, A: a, B: b });
  }
  await Promise.all([
    audio(host, "SetDiagnosticRoomInput", { enabled: false, frequencyHz: 0, gain: 0, requestedDelayMs: 0 }),
    audio(guest, "SetDiagnosticRoomInput", { enabled: false, frequencyHz: 0, gain: 0, requestedDelayMs: 0 }),
    audio(host, "StopRecording"), audio(guest, "StopRecording"),
  ]);
  const [hostAudio, guestAudio] = await Promise.all([wav(hostWav), wav(guestWav)]);
  const audible = [];
  for (let second = 0; second < scenario.durationSeconds; second++) {
    const phase = scenario.name === "standard" ? phaseAtSecond(second) : "BOTH";
    audible.push({ second, phase,
      hostHearsB: toneContinuity(hostAudio.mono, hostAudio.rate, 941, second + 0.15, second + 0.85),
      guestHearsA: toneContinuity(guestAudio.mono, guestAudio.rate, 697, second + 0.15, second + 0.85) });
  }
  const expectedB = audible.filter(item => ["B_TO_A", "BOTH"].includes(item.phase));
  const expectedA = audible.filter(item => ["A_TO_B", "BOTH"].includes(item.phase));
  const heardB = expectedB.reduce((sum, item) => sum + item.hostHearsB, 0) / expectedB.length;
  const heardA = expectedA.reduce((sum, item) => sum + item.guestHearsA, 0) / expectedA.length;
  const cutSeries = ["A", "B"].map(side => {
    let prior = number(samples[0]?.[side]["RemoteLateAudioCuts.__room_server_mix__"] ?? samples[0]?.[side].RemoteLateAudioCuts);
    let maximumDelta = 0;
    for (const item of samples.slice(1)) { const current = number(item[side]["RemoteLateAudioCuts.__room_server_mix__"] ?? item[side].RemoteLateAudioCuts); maximumDelta = Math.max(maximumDelta, current - prior); prior = current; }
    return maximumDelta;
  });
  const consecutiveCutSeries = ["A", "B"].map(side => Math.max(...samples.map(item =>
    number(item[side]["RemoteMaximumConsecutiveLateAudioCuts.__room_server_mix__"]))));
  const splitSecond = scenario.name === "standard" ? 30 : scenario.name === "seek" ? seekAtSecond : scenario.durationSeconds;
  const recoverySecond = scenario.name === "standard" ? 35 : scenario.name === "seek" ? seekAtSecond + 5 : scenario.durationSeconds;
  const preReconnectConsecutiveCutSeries = ["A", "B"].map(side => Math.max(0, ...samples
    .filter(item => item.second < splitSecond).map(item =>
      number(item[side]["RemoteMaximumConsecutiveLateAudioCuts.__room_server_mix__"]))));
  const postRecoveryConsecutiveCutSeries = ["A", "B"].map(side => Math.max(0, ...samples
    .filter(item => item.second >= recoverySecond).map(item =>
      number(item[side]["RemoteMaximumConsecutiveLateAudioCuts.__room_server_mix__"]))));
  const activeCutSeries = ["A", "B"].map(side => maximumActiveLateCutDelta(samples, item =>
    number(item[side]["RemoteLateAudioCuts.__room_server_mix__"] ?? item[side].RemoteLateAudioCuts)));
  const exclusions = samples.some(item => [item.A, item.B].some(value => value["RemoteTimelineExcluded.__room_server_mix__"] === "1"));
  const serverEntries = [];
  if (serverData) {
    const diagnosticsDirectory = path.join(serverData, "logs", "room-diagnostics", roomCode);
    for (const file of await fs.readdir(diagnosticsDirectory).catch(() => [])) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = (await fs.readFile(path.join(diagnosticsDirectory, file), "utf8")).split(/\r?\n/).filter(Boolean);
      serverEntries.push(...lines.map(line => JSON.parse(line)));
    }
  } else {
    serverEntries.push(...samples.map(item => ({ at: item.second, participantId: "A", values: item.A })));
  }
  const gapAnalysis = analyzeRoomAudioGaps(serverEntries, samples);
  report = { result: "PASS", scenario: scenario.name, durationSeconds: scenario.durationSeconds + 10, roomCode, server: { apiBase, relayHost, httpPort, relayPort, external: endpoint.external }, negotiation,
    personalControls: { levels: personalControlLevels, wav: personalControlsWav },
    directions: { aToBContinuity: heardA, bToAContinuity: heardB }, maximumOneSecondLateCutDelta: cutSeries,
    maximumConsecutiveLateAudioCuts: consecutiveCutSeries,
    activeMaximumConsecutiveLateAudioCuts: {
      beforeReconnect: preReconnectConsecutiveCutSeries,
      afterRecovery: postRecoveryConsecutiveCutSeries,
    },
    maximumActiveOneSecondLateCutDelta: activeCutSeries, gapAnalysis,
    excluded: exclusions, samples, audible, wav: { hostWav, guestWav } };
  await Promise.all([host.screenshot({ path: path.join(artifacts, "host-final.png") }), guest.screenshot({ path: path.join(artifacts, "guest-final.png") })]);
  if (heardA < 0.9 || heardB < 0.9) throw new Error(`Final PCM continuity failed: A→B=${heardA}, B→A=${heardB}`);
  // PCM loss concealment covers a short scheduling hiccup; the old live failure produced runs of
  // 38 cuts (~95 ms). Ten 2.5-ms packets is the regression boundary before a gap becomes a
  // perceptible disappearance rather than an isolated concealed transport event.
  const activeConsecutiveCutSeries = [...preReconnectConsecutiveCutSeries, ...postRecoveryConsecutiveCutSeries];
  if (Math.max(...activeConsecutiveCutSeries) > 10 || exclusions)
    throw new Error(`Remote voice became unstable while singing: activeConsecutiveLateCuts=${activeConsecutiveCutSeries}, activeOneSecondDelta=${activeCutSeries}, consecutiveLateCuts=${consecutiveCutSeries}, oneSecondDelta=${cutSeries}, excluded=${exclusions}`);
} catch (error) {
  report = { ...report, result: "FAIL", roomCode, error: error.stack ?? String(error), launcherLog, serverLog };
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(artifacts, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(artifacts, "report.md"), `# Multi-Electron room audio E2E\n\n- Result: **${report.result}**\n- Scenario: ${report.scenario ?? scenario.name}\n- Duration: ${report.durationSeconds ?? scenario.durationSeconds} seconds\n- Production path: Electron A/B → RoomSync/IPC → AudioService A/B → Room Server → final master PCM\n- Artifacts: ${artifacts}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  await Promise.allSettled([hostBrowser?.close(), guestBrowser?.close()]);
  for (const pid of [...new Set(electronPids)]) await new Promise(resolve => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    killer.once("exit", resolve); killer.once("error", resolve);
  });
  if (launcher.exitCode === null) launcher.kill();
  if (roomServer?.exitCode === null) roomServer.kill();
  await fs.writeFile(path.join(artifacts, "launcher.log"), launcherLog);
  await fs.writeFile(path.join(artifacts, "room-server.log"), serverLog);
  console.log(JSON.stringify({ result: report.result, artifacts }));
}
