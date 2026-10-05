// Optional Windows hardware gate for the production backends. Unlike the deterministic C++
// matrix, this launches the real AudioService executable and exercises WASAPI/ASIO through the
// native relay. Unsupported/uninstalled backends are reported as skipped; --require makes one
// backend mandatory.
//
// Usage:
//   node AudioService/tools/real-backend-room-gate.mjs artifacts/room-e2e/real-backends
//   node AudioService/tools/real-backend-room-gate.mjs <out-dir> --require asio
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("The real backend gate requires Windows");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const audioExecutable = process.env.AD_VOICE_AUDIO_SERVICE
  ?? path.join(root, "AudioService", "build", "Release", "AudioService.exe");
const relayExecutable = path.join(root, "AudioService", "build", "Release", "NativeVoiceRelay.exe");
const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? path.join(root, "artifacts", "room-e2e", "real-backends"));
const requiredIndex = args.indexOf("--require");
const required = requiredIndex >= 0 ? args[requiredIndex + 1] : undefined;
mkdirSync(outDir, { recursive: true });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const parse = text => Object.fromEntries(text.split(/\r?\n/).map(line => {
  const separator = line.indexOf(": ");
  return separator < 0 ? null : [line.slice(0, separator), line.slice(separator + 2)];
}).filter(Boolean));
const lineReader = child => {
  const lines = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line); else lines.push(line);
  });
  return () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process response timed out")), 5_000);
    waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject });
  });
};
const once = (pipe, line) => new Promise((resolve, reject) => {
  const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`);
  let text = "";
  socket.once("connect", () => socket.write(`${line}\n`));
  socket.on("data", chunk => { text += chunk.toString("utf8"); });
  socket.once("close", () => resolve(text));
  socket.once("error", reject);
});
const audio = async (client, command, values = {}) => {
  const line = ["1", command, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("|");
  for (let attempt = 0; attempt <= 60; ++attempt) {
    try {
      const response = await once(client.pipe, line);
      if (!response.startsWith("0|")) throw new Error(response.slice(2).trim() || `${command} failed`);
      return response.slice(2);
    } catch (error) {
      if (attempt === 60 || !String(error).includes("ENOENT")) throw error;
      await delay(100);
    }
  }
};
const commandLine = async (relay, nextLine, command) => {
  relay.stdin.write(`${command}\n`);
  const response = await nextLine();
  if (response !== "OK") throw new Error(`${command} failed: ${response}`);
};

const suffix = crypto.randomUUID().slice(0, 8);
const port = 41_000 + Math.floor(Math.random() * 10_000);
const relay = spawn(relayExecutable, ["--port", String(port)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const nextRelayLine = lineReader(relay);
const clients = ["sender", "receiver"].map(name => ({
  name, participant: `${name}-${suffix}`, pipe: `ADVoice.RealBackendGate.${suffix}.${name}`,
}));
const processes = clients.map(client => spawn(audioExecutable, [], {
  env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: `\\\\.\\pipe\\${client.pipe}`, AD_VOICE_ROOM_E2E: "1" },
  stdio: "ignore", windowsHide: true,
}));
const report = { startedAt: new Date().toISOString(), kind: "REAL_WINDOWS_BACKEND_INTEGRATION_GATE", results: [] };
const backendNames = { "wasapi-shared": "WASAPI Shared", "wasapi-exclusive": "WASAPI Exclusive", asio: "ASIO" };
const stageKeys = [
  "RemoteDecodedPeak.__room_server_mix__", "RemoteQueuedPeak.__room_server_mix__",
  "RemoteRenderedPeak.__room_server_mix__", "RemoteMixPeak", "MasterOutputPeak", "BackendOutputPeak",
];

try {
  if (!(await nextRelayLine()).startsWith("READY")) throw new Error("Native relay did not become ready");
  const room = `real-backend-${suffix}`;
  for (const [index, client] of clients.entries())
    await commandLine(relay, nextRelayLine, `EXPECT\t${room}\t${client.participant}\t${index + 101}`);
  await commandLine(relay, nextRelayLine, `ELIGIBLE\t${room}\t${clients[0].participant}\t${clients[1].participant}`);
  await commandLine(relay, nextRelayLine, `DEADLINE\t${room}\t80`);

  const sender = clients[0];
  // The sender also uses the production Windows callback path so the diagnostic pilot advances
  // without any test-only FakeAudioBackend pumping.
  await audio(sender, "Reconfigure", { backend: "wasapi-shared", input: "", output: "",
    rate: 48_000, period: 0, inChannels: 1, outChannels: 2 });
  await audio(sender, "StartSession").catch(() => undefined);
  const senderClock = Number(parse(await audio(sender, "GetDiagnostics")).MonotonicTicks) / 1_000;
  await audio(sender, "SetRoomClock", { serverMicros: Date.now() * 1_000, localMicros: Math.round(senderClock) });
  await audio(sender, "AddRemoteParticipant", { participantId: "__room_server_mix__" });
  await audio(sender, "JoinMediaSession", { localParticipantId: sender.participant, localPort: 0,
    host: "127.0.0.1", remotePort: port, voiceToken: "65" });
  await audio(sender, "SetRoomPlayoutDelay", { milliseconds: 80 });
  await audio(sender, "SetDiagnosticRoomInput", { enabled: true, frequencyHz: 523.25, gain: 0.05,
    requestedDelayMs: 60, resetLateCutSeries: true });
  await delay(500);
  const senderDiagnostics = parse(await audio(sender, "GetDiagnostics"));
  report.sender = Object.fromEntries([
    "SessionState", "Backend", "GraphStages", "SessionFrame", "NetworkTransportRunning",
    "NetworkSendEnabled", "NetworkPacketsSent", "NetworkSendQueueFill", "RoomVoiceUpstreamPeak",
    "ClockBridgeUnderruns", "StaleCallbacks",
  ].map(key => [key, senderDiagnostics[key]]));

  for (const backend of Object.keys(backendNames).filter(name => !required || name === required)) {
    const receiver = clients[1];
    const result = { backend, requestedBackend: backendNames[backend] };
    try {
      const scenarioRoom = `${room}-${backend}`;
      await commandLine(relay, nextRelayLine, `EXPECT\t${scenarioRoom}\t${sender.participant}\t101`);
      await commandLine(relay, nextRelayLine, `EXPECT\t${scenarioRoom}\t${receiver.participant}\t102`);
      await commandLine(relay, nextRelayLine,
        `ELIGIBLE\t${scenarioRoom}\t${sender.participant}\t${receiver.participant}`);
      await commandLine(relay, nextRelayLine, `DEADLINE\t${scenarioRoom}\t80`);
      await audio(sender, "JoinMediaSession", { localParticipantId: sender.participant, localPort: 0,
        host: "127.0.0.1", remotePort: port, voiceToken: "65" });
      const configure = () => audio(receiver, "Reconfigure", {
        backend, input: "", output: "", rate: 0, period: 0, inChannels: 1, outChannels: 2,
      });
      await configure();
      await audio(receiver, "StartSession").catch(() => undefined);
      const receiverClock = Number(parse(await audio(receiver, "GetDiagnostics")).MonotonicTicks) / 1_000;
      await audio(receiver, "SetRoomClock", { serverMicros: Date.now() * 1_000, localMicros: Math.round(receiverClock) });
      await audio(receiver, "AddRemoteParticipant", { participantId: "__room_server_mix__" });
      await audio(receiver, "JoinMediaSession", { localParticipantId: receiver.participant, localPort: 0,
        host: "127.0.0.1", remotePort: port, voiceToken: "66" });
      await audio(receiver, "SetRoomPlayoutDelay", { milliseconds: 80 });
      await delay(2_000);
      const before = parse(await audio(receiver, "GetDiagnostics"));
      relay.stdin.write(`METRICS\t${scenarioRoom}\t${receiver.participant}\n`);
      result.relay = JSON.parse(await nextRelayLine());

      await configure();
      await audio(receiver, "StartSession").catch(() => undefined);
      await delay(1_000);
      const afterReconfigure = parse(await audio(receiver, "GetDiagnostics"));
      const recovered = await audio(receiver, "RecoverSession");
      await delay(1_000);
      const afterRecovery = parse(await audio(receiver, "GetDiagnostics"));

      await audio(receiver, "StopSession");
      await audio(receiver, "PrepareSession", { backend, input: "", output: "", rate: 0, period: 0,
        inChannels: 1, outChannels: 2 });
      await audio(receiver, "StartSession");
      await audio(receiver, "SetRoomClock", { serverMicros: Date.now() * 1_000, localMicros: Math.round(
        Number(parse(await audio(receiver, "GetDiagnostics")).MonotonicTicks) / 1_000) });
      await audio(receiver, "AddRemoteParticipant", { participantId: "__room_server_mix__" });
      await audio(receiver, "JoinMediaSession", { localParticipantId: receiver.participant, localPort: 0,
        host: "127.0.0.1", remotePort: port, voiceToken: "66" });
      await audio(receiver, "SetRoomPlayoutDelay", { milliseconds: 80 });
      await delay(1_000);
      const afterRestart = parse(await audio(receiver, "GetDiagnostics"));
      const snapshots = { before, afterReconfigure, afterRecovery, afterRestart };
      const identity = snapshot => ({ backend: snapshot.Backend, input: snapshot.ActiveInputDeviceId,
        output: snapshot.ActiveOutputDeviceId, rate: Number(snapshot.RuntimeOutputSampleRate),
        period: Number(snapshot.RuntimeOutputPeriodFrames), generation: Number(snapshot.generationId) });
      result.actual = Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, identity(snapshot)]));
      result.stages = Object.fromEntries(stageKeys.map(key => [key, Number(before[key] ?? 0)]));
      result.network = { sent: Number(before.NetworkPacketsSent ?? 0),
        received: Number(before.NetworkPacketsReceived ?? 0), transport: Number(before.NetworkTransportRunning ?? 0),
        sendEnabled: Number(before.NetworkSendEnabled ?? 0) };
      result.remoteDiagnostics = Object.fromEntries(Object.entries(before).filter(([key]) =>
        key.startsWith("Remote") || key.startsWith("RoomShared") || key.startsWith("NetworkStale")));
      result.recovered = recovered.trim();
      const correctBackend = Object.values(snapshots).every(snapshot => snapshot.Backend === backendNames[backend]);
      const pcmReachedHardware = Object.values(snapshots).every(snapshot =>
        stageKeys.every(key => Number(snapshot[key] ?? 0) > 0));
      result.status = correctBackend && pcmReachedHardware ? "passed" : "failed";
      if (result.status === "failed") result.error = `backend identity or PCM stage invariant failed`;
    } catch (error) {
      result.status = "skipped";
      result.error = String(error?.message ?? error);
    }
    report.results.push(result);
  }
} finally {
  relay.stdin.write("STOP\n");
  for (const child of processes) child.kill();
  relay.kill();
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
}

const failed = report.results.filter(result => result.status === "failed");
const requiredResult = required && report.results.find(result => result.backend === required);
if (failed.length || (required && requiredResult?.status !== "passed")) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
}
