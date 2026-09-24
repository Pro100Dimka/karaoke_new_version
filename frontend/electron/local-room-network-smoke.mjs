import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImpairment } from "./network-impairment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = path.join(root, "AudioService", "build", "Release", "AudioService.exe");
const suffix = crypto.randomUUID().slice(0, 8);
const token = "123456789abcdef0";
const clients = [
  { participantId: `local-A-${suffix}`, pipe: `ADVoice.LocalNetwork.${suffix}.A` },
  { participantId: `local-B-${suffix}`, pipe: `ADVoice.LocalNetwork.${suffix}.B` }
];
const participantKey = id => {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
};
const keys = new Map(clients.map(client => [participantKey(client.participantId), client]));
const processes = clients.map(client => spawn(executable, [], {
  env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: "\\\\.\\pipe\\" + client.pipe },
  windowsHide: true,
  stdio: "ignore"
}));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const audio = async (pipeName, line) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection("\\\\.\\pipe\\" + pipeName);
        let output = "";
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(output);
        };
        socket.once("connect", () => socket.write(`${line}\n`));
        socket.on("data", chunk => { output += chunk.toString("utf8"); });
        socket.once("end", finish);
        socket.once("close", finish);
        socket.once("error", error => output.endsWith("\n") ? finish() : reject(error));
      });
    } catch (error) {
      if (attempt === 49) throw error;
      await delay(100);
    }
  }
  throw new Error("AudioService pipe did not open");
};
const diagnosticNumber = (text, name) => Number(new RegExp(`${name}: ([0-9.]+)`).exec(text)?.[1] ?? 0);
const diagnosticText = (text, name) => new RegExp(`${name}: ([^\r\n]+)`).exec(text)?.[1] ?? "missing";
const proxy = dgram.createSocket("udp4");
const endpoints = new Map();
const pendingTimers = new Set();
let startedAt = performance.now();
const impairments = new Map([
  [participantKey(clients[0].participantId), createImpairment({
    stages: [
      { untilMs: 3_000, latencyMs: 20 },
      { untilMs: 6_000, latencyMs: 100 },
      { untilMs: Number.POSITIVE_INFINITY, latencyMs: 30 }
    ],
    jitterMs: 10,
    loss: 0.01,
    duplicate: 0.002,
    reorder: 0.005
  }, 12_345)],
  [participantKey(clients[1].participantId), createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 65 }],
    jitterMs: 20,
    loss: 0.01,
    duplicate: 0.002,
    reorder: 0.005
  }, 54_321)]
]);
const schedule = (message, endpoint, delayMs) => {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    proxy.send(message, endpoint.port, endpoint.address);
  }, delayMs);
  pendingTimers.add(timer);
};
proxy.on("message", (message, source) => {
  if (message.length < 36) return;
  const key = message.readUInt32LE(12);
  if (!keys.has(key)) return;
  endpoints.set(key, { address: source.address, port: source.port });
  const impairment = impairments.get(key)?.(performance.now() - startedAt) ?? {
    dropped: false, delayMs: 0, duplicate: false
  };
  schedule(message, source, impairment.delayMs * 2);
  if (impairment.dropped) return;
  for (const [otherKey, endpoint] of endpoints) {
    if (otherKey === key) continue;
    schedule(message, endpoint, impairment.delayMs);
    if (impairment.duplicate) schedule(message, endpoint, impairment.delayMs + 1);
  }
});

try {
  await new Promise(resolve => proxy.bind(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;
  const setupResponses = [];
  setupResponses.push(...await Promise.all(clients.map(client => audio(
    client.pipe, "1|Reconfigure|backend=wasapi-shared|rate=0|period=0|inChannels=0|outChannels=0"
  ))));
  setupResponses.push(...await Promise.all(clients.map(client => audio(client.pipe, "1|StartSession"))));
  setupResponses.push(...await Promise.all(clients.map((client, index) => audio(
    client.pipe, `1|AddRemoteParticipant|participantId=${clients[1 - index].participantId}`
  ))));
  setupResponses.push(await audio(clients[0].pipe,
    `1|JoinMediaSession|localParticipantId=${clients[0].participantId}|localPort=0|host=127.0.0.1|remotePort=${proxyPort}|voiceToken=${token}`));
  await delay(300);
  setupResponses.push(await audio(clients[1].pipe,
    `1|JoinMediaSession|localParticipantId=${clients[1].participantId}|localPort=0|host=127.0.0.1|remotePort=${proxyPort}|voiceToken=${token}`));
  if (setupResponses.some(response => !response.startsWith("0|")))
    throw new Error(`Local room setup failed: ${JSON.stringify(setupResponses)}`);
  const songRoot = path.join(process.env.APPDATA ?? "", "ad-voice-frontend", "backend-data", "songs");
  const songFiles = await fs.readdir(songRoot, { recursive: true });
  const referenceRelative = songFiles.find(file => file.endsWith("reference-vocal.wav"));
  if (!referenceRelative) throw new Error(`No processed reference vocal found under ${songRoot}`);
  const referenceVocal = path.join(songRoot, referenceRelative);
  setupResponses.push(...await Promise.all(clients.map(client => audio(
    client.pipe, `1|LoadSong|instrumental=${referenceVocal}|vocals=${referenceVocal}`
  ))));
  await delay(1_000);
  await Promise.all(clients.map(client => audio(client.pipe, "1|SetMusicGain|value=0")));
  setupResponses.push(...await Promise.all(clients.map(client => audio(client.pipe, "1|Play|context=karaoke"))));
  setupResponses.push(await audio(
    clients[0].pipe,
    "1|Reconfigure|backend=wasapi-shared|rate=0|period=0|inChannels=0|outChannels=0"
  ));
  startedAt = performance.now();

  await delay(2_500);
  const baselineDiagnostics = await audio(clients[1].pipe, "1|GetDiagnostics");
  await delay(3_000);
  const spikeDiagnostics = await audio(clients[1].pipe, "1|GetDiagnostics");
  await delay(3_000);
  const recoveryDiagnostics = await audio(clients[1].pipe, "1|GetDiagnostics");
  await audio(clients[1].pipe, "1|LeaveMediaSession");
  await delay(250);
  await audio(clients[1].pipe,
    `1|JoinMediaSession|localParticipantId=${clients[1].participantId}|localPort=0|host=127.0.0.1|remotePort=${proxyPort}|voiceToken=${token}`);
  await delay(2_000);

  const diagnostics = await Promise.all(clients.map(client => audio(client.pipe, "1|GetDiagnostics")));
  const stagedTargets = {
    baseline: diagnosticNumber(baselineDiagnostics, `RemoteTargetDelayFrames\\.${clients[0].participantId}`),
    spike: diagnosticNumber(spikeDiagnostics, `RemoteTargetDelayFrames\\.${clients[0].participantId}`),
    recovery: diagnosticNumber(recoveryDiagnostics, `RemoteTargetDelayFrames\\.${clients[0].participantId}`)
  };
  const result = diagnostics.map((text, index) => ({
    client: clients[index].participantId,
    sent: diagnosticNumber(text, "NetworkPacketsSent"),
    received: diagnosticNumber(text, "NetworkPacketsReceived"),
    roundTripMs: diagnosticNumber(text, "NetworkRoundTripMs"),
    jitterMs: diagnosticNumber(text, `RemoteJitterMs\\.${clients[1 - index].participantId}`),
    targetDelayFrames: diagnosticNumber(text, `RemoteTargetDelayFrames\\.${clients[1 - index].participantId}`),
    queueFrames: diagnosticNumber(text, `RemoteQueueFrames\\.${clients[1 - index].participantId}`),
    xruns: diagnosticNumber(text, "Xruns"),
    transportRunning: diagnosticNumber(text, "NetworkTransportRunning"),
    sendEnabled: diagnosticNumber(text, "NetworkSendEnabled"),
    sessionState: diagnosticText(text, "SessionState"),
    failure: diagnosticText(text, "LastFailureMessage"),
    inputRms: diagnosticNumber(text, "InputRMS"),
    sharedTimeline: diagnosticNumber(text, "RoomSharedTimeline")
  }));
  if (setupResponses.some(response => !response.startsWith("0|")) ||
      result.some(item => item.sent === 0 || item.received === 0 || item.roundTripMs === 0 ||
      item.targetDelayFrames === 0 || item.sharedTimeline !== 1) ||
      stagedTargets.spike <= stagedTargets.baseline || stagedTargets.recovery > stagedTargets.spike) {
    throw new Error(`Local room network smoke failed: ${JSON.stringify({ setupResponses, stagedTargets, result })}`);
  }
  console.log(JSON.stringify({ proxyPort, seed: [12_345, 54_321], referenceVocal,
    stagedTargets, result }));
} finally {
  for (const timer of pendingTimers) clearTimeout(timer);
  proxy.close();
  for (const child of processes) child.kill();
}
