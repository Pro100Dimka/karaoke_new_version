import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { phaseAtSecond, toneContinuity, toneState, validateNegotiation } from "./multi-electron-room-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const frontendRoot = path.join(root, "frontend");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
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
const httpPort = await freePort();
const relayPort = await freePort();
const serverData = await fs.mkdtemp(path.join(os.tmpdir(), "ad-voice-electron-room-e2e-"));
const python = path.join(root, "python", ".venv", "Scripts", "python.exe");
const roomServer = spawn(python, ["-m", "backend.room_server_main"], {
  cwd: path.join(root, "python"), windowsHide: true,
  env: { ...process.env, PYTHONPATH: path.join(root, "python"),
    AD_VOICE_ROOM_SERVER_PORT: String(httpPort), AD_VOICE_ROOM_SERVER_RELAY_PORT: String(relayPort),
    AD_VOICE_ROOM_SERVER_DATA: serverData },
});
let serverLog = "";
roomServer.stdout.on("data", chunk => { serverLog += chunk; });
roomServer.stderr.on("data", chunk => { serverLog += chunk; });

const api = async (route, options) => {
  const response = await fetch(`http://127.0.0.1:${httpPort}${route}`, {
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
  AD_VOICE_ROOM_SERVER_HOST: "127.0.0.1", AD_VOICE_ROOM_SERVER_PORT: String(httpPort),
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
  await host.locator(".roomCode").waitFor({ timeout: 30_000 });
  const title = await host.locator(".roomCode").getAttribute("title");
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
const hostWav = path.join(artifacts, "host-master.wav"), guestWav = path.join(artifacts, "guest-master.wav");
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
    audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: 0, requestedDelayMs: 80 }),
    audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: 80 }),
  ]);
  for (let attempt = 0; attempt < 120; attempt++) {
    state = await api(`/rooms/${roomCode}`);
    if (state.participants?.length === 2 &&
        state.participants.every(item => item.voiceTimingReady && item.voiceEligible && item.voiceLatencyMs === 80)) break;
    await wait(250);
  }
  if (!state.participants?.every(item => item.voiceEligible && item.voiceLatencyMs === 80))
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
  const negotiation = { fallback: fallbackNegotiation, live: liveNegotiation };
  await Promise.all([
    audio(host, "PrepareRecording", { id: "multi-e2e-host", path: hostWav, tap: "master" }),
    audio(guest, "PrepareRecording", { id: "multi-e2e-guest", path: guestWav, tap: "master" }),
  ]);
  await Promise.all([audio(host, "StartRecording"), audio(guest, "StartRecording")]);
  const startClock = performance.now();
  const samples = [];
  for (let second = 0; second < 60; second++) {
    const phase = phaseAtSecond(second), [gainA, gainB] = toneState(phase);
    if (phase === "RECONNECT_B") {
      await guest.evaluate(() => window.roomE2eReconnectVoiceSession?.());
      await audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: 0, requestedDelayMs: 80 });
      await host.screenshot({ path: path.join(artifacts, "reconnect.png") });
    }
    await Promise.all([
      audio(host, "SetDiagnosticRoomInput", { frequencyHz: 697, gain: gainA, requestedDelayMs: 80 }),
      audio(guest, "SetDiagnosticRoomInput", { frequencyHz: 941, gain: gainB, requestedDelayMs: 80 }),
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
  for (let second = 0; second < 60; second++) {
    const phase = phaseAtSecond(second);
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
  const exclusions = samples.some(item => [item.A, item.B].some(value => value["RemoteTimelineExcluded.__room_server_mix__"] === "1"));
  report = { result: "PASS", durationSeconds: 60, roomCode, server: { httpPort, relayPort }, negotiation,
    directions: { aToBContinuity: heardA, bToAContinuity: heardB }, maximumOneSecondLateCutDelta: cutSeries,
    maximumConsecutiveLateAudioCuts: consecutiveCutSeries,
    excluded: exclusions, samples, audible, wav: { hostWav, guestWav } };
  await Promise.all([host.screenshot({ path: path.join(artifacts, "host-final.png") }), guest.screenshot({ path: path.join(artifacts, "guest-final.png") })]);
  if (heardA < 0.9 || heardB < 0.9) throw new Error(`Final PCM continuity failed: A→B=${heardA}, B→A=${heardB}`);
  // PCM loss concealment covers a short scheduling hiccup; the old live failure produced runs of
  // 38 cuts (~95 ms). Ten 2.5-ms packets is the regression boundary before a gap becomes a
  // perceptible disappearance rather than an isolated concealed transport event.
  if (Math.max(...consecutiveCutSeries) > 10 || exclusions)
    throw new Error(`Remote voice became unstable: consecutiveLateCuts=${consecutiveCutSeries}, oneSecondDelta=${cutSeries}, excluded=${exclusions}`);
} catch (error) {
  report = { ...report, result: "FAIL", roomCode, error: error.stack ?? String(error), launcherLog, serverLog };
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(artifacts, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(artifacts, "report.md"), `# Multi-Electron room audio E2E\n\n- Result: **${report.result}**\n- Duration: 60 seconds\n- Production path: Electron A/B → RoomSync/IPC → AudioService A/B → Room Server → final master PCM\n- Artifacts: ${artifacts}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  await Promise.allSettled([hostBrowser?.close(), guestBrowser?.close()]);
  for (const pid of [...new Set(electronPids)]) await new Promise(resolve => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    killer.once("exit", resolve); killer.once("error", resolve);
  });
  if (launcher.exitCode === null) launcher.kill();
  if (roomServer.exitCode === null) roomServer.kill();
  await fs.writeFile(path.join(artifacts, "launcher.log"), launcherLog);
  await fs.writeFile(path.join(artifacts, "room-server.log"), serverLog);
  console.log(JSON.stringify({ result: report.result, artifacts }));
}
