import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImpairment } from "./network-impairment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const candidates = [
  path.join(root, "AudioService", "build", "Release", "AudioService.exe"),
  path.join(root, "AudioService", "build", "Debug", "AudioService.exe")
];
const executable = (await Promise.all(candidates.map(async candidate =>
  await fs.access(candidate).then(() => candidate).catch(() => null)))).find(Boolean);
if (!executable) throw new Error("Build AudioService before running the process network test");

const songRoot = path.join(process.env.APPDATA ?? "", "ad-voice-frontend", "backend-data", "songs");
const songFiles = await fs.readdir(songRoot, { recursive: true });
const relativeVocal = songFiles.find(file => file.endsWith("reference-vocal.wav"));
if (!relativeVocal) throw new Error(`No reference-vocal.wav found under ${songRoot}`);
const referenceVocal = path.join(songRoot, relativeVocal);
const artifactRoot = path.join(root, "AudioService", "build", "network-process-test");
await fs.mkdir(artifactRoot, { recursive: true });
const clientAPath = path.join(artifactRoot, "client-a.wav");
const clientBPath = path.join(artifactRoot, "client-b.wav");
const evidencePath = path.join(artifactRoot, "network-test-output.wav");
const reportPath = path.join(artifactRoot, "network-test-report.json");

const participantKey = id => {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
};
const clients = [
  { id: "network-vocal-A", output: clientAPath },
  { id: "network-vocal-B", output: clientBPath }
];
const endpoints = new Map();
const timers = new Set();
const startedAt = performance.now();
const impairments = new Map([
  [participantKey(clients[0].id), createImpairment({
    stages: [
      { untilMs: 3_000, latencyMs: 20 },
      { untilMs: 6_000, latencyMs: 100 },
      { untilMs: Number.POSITIVE_INFINITY, latencyMs: 30 }
    ], jitterMs: 10, loss: 0.01, duplicate: 0.002, reorder: 0.005
  }, 12_345)],
  [participantKey(clients[1].id), createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 65 }],
    jitterMs: 20, loss: 0.01, duplicate: 0.002, reorder: 0.005
  }, 54_321)]
]);
const proxy = dgram.createSocket("udp4");
const schedule = (message, endpoint, milliseconds) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    proxy.send(message, endpoint.port, endpoint.address);
  }, milliseconds);
  timers.add(timer);
};
proxy.on("message", (message, source) => {
  if (message.length < 36) return;
  const key = message.readUInt32LE(12);
  endpoints.set(key, { address: source.address, port: source.port });
  const impairment = impairments.get(key)?.(performance.now() - startedAt);
  if (!impairment) return;
  schedule(message, source, impairment.delayMs * 2);
  if (impairment.dropped) return;
  for (const [otherKey, endpoint] of endpoints) {
    if (otherKey === key) continue;
    schedule(message, endpoint, impairment.delayMs);
    if (impairment.duplicate) schedule(message, endpoint, impairment.delayMs + 1);
  }
});
await new Promise(resolve => proxy.bind(0, "127.0.0.1", resolve));

const run = (client, remote, startAtMs) => new Promise((resolve, reject) => {
  const child = spawn(executable, [
    "--network-test-client", "--input", referenceVocal, "--output", client.output,
    "--local-id", client.id, "--remote-id", remote.id,
    "--remote-port", String(proxy.address().port), "--token", "123456789abcdef0",
    "--start-at-ms", String(startAtMs)
  ], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve(JSON.parse(stdout)) :
    reject(new Error(`${client.id} exited ${code}: ${stderr || stdout}`)));
});

const readMonoWav = async file => {
  const bytes = await fs.readFile(file);
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") format = {
      type: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
      rate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22)
    };
    if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  if (!format || !data || format.channels !== 1 || format.bits !== 16)
    throw new Error(`Unsupported evidence WAV: ${file}`);
  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = data.readInt16LE(index * 2) / 32768;
  return { rate: format.rate, samples };
};

const correlate = (left, right, maximumOffset = 480) => {
  const frames = Math.min(left.length, right.length);
  const window = Math.min(frames, 24_000);
  const candidates = [];
  for (let start = 0; start + window <= frames; start += window) {
    let leftEnergy = 0, rightEnergy = 0;
    for (let index = 0; index < window; index += 32) {
      leftEnergy += left[start + index] ** 2;
      rightEnergy += right[start + index] ** 2;
    }
    candidates.push({ start, sharedEnergy: Math.sqrt(leftEnergy * rightEnergy) });
  }
  candidates.sort((a, b) => b.sharedEnergy - a.sharedEnergy);
  const energeticWindows = candidates.slice(0, 8);
  let best = { offsetSamples: 0, peakCorrelation: -1 };
  for (let shift = -maximumOffset; shift <= maximumOffset; shift += 1) {
    for (const candidate of energeticWindows) {
      const leftStart = candidate.start + Math.max(0, -shift);
      const rightStart = candidate.start + Math.max(0, shift);
      const count = Math.min(window, left.length - leftStart, right.length - rightStart);
      let product = 0, leftEnergy = 0, rightEnergy = 0;
      for (let index = 0; index < count; index += 16) {
        const a = left[leftStart + index], b = right[rightStart + index];
        product += a * b; leftEnergy += a * a; rightEnergy += b * b;
      }
      const peakCorrelation = product / Math.sqrt(leftEnergy * rightEnergy || 1);
      if (peakCorrelation > best.peakCorrelation)
        best = { offsetSamples: shift, peakCorrelation };
    }
  }
  return best;
};

const writeEvidence = async (file, rate, left, right) => {
  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * 3 * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(3, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 6, 28);
  bytes.writeUInt16LE(6, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const a = left[frame], b = right[frame];
    for (const [channel, sample] of [a, b, (a + b) * 0.5].entries())
      bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
        44 + (frame * 3 + channel) * 2);
  }
  await fs.writeFile(file, bytes);
};

try {
  const startAtMs = Date.now() + 3_000;
  const processReports = await Promise.all([
    run(clients[0], clients[1], startAtMs), run(clients[1], clients[0], startAtMs)
  ]);
  const [clientA, clientB] = await Promise.all([readMonoWav(clientAPath), readMonoWav(clientBPath)]);
  // The route changes for the first six seconds. Measure the final stable period after the
  // compensation loop has recovered, rather than treating the deliberately disturbed transition
  // as permanent room skew.
  const analysisStartFrame = 10 * clientA.rate;
  const alignment = correlate(clientA.samples.subarray(analysisStartFrame),
    clientB.samples.subarray(analysisStartFrame));
  await writeEvidence(evidencePath, clientA.rate, clientA.samples, clientB.samples);
  const report = {
    seed: [12_345, 54_321], referenceVocal, evidencePath, reportPath, processReports,
    offsetSamples: alignment.offsetSamples,
    offsetMs: alignment.offsetSamples * 1_000 / clientA.rate,
    peakCorrelation: alignment.peakCorrelation,
    analysisWindowSeconds: [10, 15]
  };
  if (Math.abs(report.offsetSamples) > 96 || report.peakCorrelation < 0.75 ||
      processReports.some(item => item.packetsSent === 0 || item.packetsReceived === 0 ||
        Math.abs(item.clockDriftPpm) > 500 || Math.abs(item.clockOffsetMs) > 1_000))
    throw new Error(`Process alignment failed: ${JSON.stringify(report)}`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} finally {
  for (const timer of timers) clearTimeout(timer);
  proxy.close();
}
