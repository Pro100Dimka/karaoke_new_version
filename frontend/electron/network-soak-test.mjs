import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImpairment } from "./network-impairment.mjs";

const argument = process.argv.find(value => value.startsWith("--minutes="));
const minutes = argument ? Number(argument.slice("--minutes=".length)) : 30;
if (!Number.isFinite(minutes) || minutes <= 0)
  throw new Error("--minutes must be a positive number");
const durationSeconds = Math.max(1, Math.round(minutes * 60));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = path.join(root, "AudioService", "build", "Release", "AudioService.exe");
await fs.access(executable);
const songRoot = path.join(process.env.APPDATA ?? "", "ad-voice-frontend", "backend-data", "songs");
const songFiles = await fs.readdir(songRoot, { recursive: true });
const relativeVocal = songFiles.find(file => file.endsWith("reference-vocal.wav"));
if (!relativeVocal) throw new Error(`No reference-vocal.wav found under ${songRoot}`);
const referenceVocal = path.join(songRoot, relativeVocal);
const artifactRoot = path.join(root, "AudioService", "build", "network-soak-test");
await fs.mkdir(artifactRoot, { recursive: true });

const ids = ["soak-A", "soak-B"];
const participantKey = id => {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
};
const keys = new Map(ids.map(id => [participantKey(id), id]));
const endpoints = new Map();
const startAtMs = Date.now() + 4_000;
const impairmentStart = performance.now() + 4_000;
const durationMs = durationSeconds * 1_000;
const profiles = new Map([
  [ids[0], {
    stages: [
      { untilMs: durationMs / 3, latencyMs: 20 },
      { untilMs: durationMs * 2 / 3, latencyMs: 95 },
      { untilMs: Number.POSITIVE_INFINITY, latencyMs: 35 }
    ],
    jitterMs: 12, loss: 0.01, duplicate: 0.002, reorder: 0.003, driftPpm: 100,
    outages: durationSeconds >= 60
      ? [{ fromMs: durationMs / 2, untilMs: durationMs / 2 + 10_000 }]
      : []
  }],
  [ids[1], {
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 60 }],
    jitterMs: 20, loss: 0.005, duplicate: 0.001, reorder: 0.002, driftPpm: -100,
    burstLoss: { everyPackets: 1_000, lengthPackets: 8 },
    bandwidthKbps: 96, queueLimitMs: 300
  }]
]);
const impairments = new Map(ids.map((id, index) => [
  id, createImpairment(profiles.get(id), 0x5a17 + index)
]));
const metrics = { forwarded: 0, dropped: 0, duplicated: 0, maximumScheduled: 0 };
const timers = new Set();
const proxy = dgram.createSocket("udp4");
const schedule = (packet, endpoint, delayMs) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    proxy.send(packet, endpoint.port, endpoint.address);
  }, delayMs);
  timers.add(timer);
  metrics.maximumScheduled = Math.max(metrics.maximumScheduled, timers.size);
};
proxy.on("message", (message, sourceEndpoint) => {
  if (message.length < 44) return;
  const sourceId = keys.get(message.readUInt32LE(12));
  if (!sourceId) return;
  endpoints.set(sourceId, sourceEndpoint);
  const destinationId = ids.find(id => id !== sourceId);
  const destination = endpoints.get(destinationId);
  if (!destination) return;
  const result = impairments.get(sourceId)(
    Math.max(0, performance.now() - impairmentStart), message.length);
  if (result.dropped) {
    metrics.dropped += 1;
    return;
  }
  schedule(message, destination, result.delayMs);
  metrics.forwarded += 1;
  if (result.duplicate) {
    schedule(message, destination, result.delayMs + 1);
    metrics.duplicated += 1;
  }
});
await new Promise(resolve => proxy.bind(0, "127.0.0.1", resolve));

const children = new Set();
const runClient = id => {
  const remoteId = ids.find(candidate => candidate !== id);
  const outputPath = path.join(artifactRoot, `${id}.wav`);
  const child = spawn(executable, [
    "--network-test-client", "--input", referenceVocal, "--output", outputPath,
    "--local-id", id, "--remote-id", remoteId,
    "--remote-port", String(proxy.address().port), "--token", "123456789abcdef0",
    "--start-at-ms", String(startAtMs), "--duration-seconds", String(durationSeconds)
  ], { windowsHide: true });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => {
      children.delete(child);
      if (code === 0) resolve({ report: JSON.parse(stdout), outputPath });
      else reject(new Error(`${id} exited ${code}: ${stderr || stdout}`));
    });
  });
};

try {
  const results = await Promise.all(ids.map(runClient));
  const reports = results.map(result => result.report);
  if (reports.some(report => !report.transportRunning || !report.sendEnabled ||
      report.packetsSent < durationSeconds * 150 || report.packetsReceived === 0 ||
      report.sharedTargetDelayFrames > 48_000 ||
      report.interPeerAlignmentErrorFrames > (durationSeconds >= 60 ? 96 : 24_000)) ||
      metrics.forwarded === 0 || metrics.dropped === 0 ||
      metrics.maximumScheduled > 1_000)
    throw new Error(`Network soak failed: ${JSON.stringify({ reports, metrics })}`);
  const reportPath = path.join(artifactRoot, "network-soak-report.json");
  const report = { minutes, durationSeconds, referenceVocal, reports, metrics, reportPath };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} finally {
  for (const timer of timers) clearTimeout(timer);
  proxy.close();
  for (const child of children) child.kill();
}
