import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImpairment } from "./network-impairment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = path.join(root, "AudioService", "build", "Release", "AudioService.exe");
await fs.access(executable);
const songRoot = path.join(process.env.APPDATA ?? "", "ad-voice-frontend", "backend-data", "songs");
const songFiles = await fs.readdir(songRoot, { recursive: true });
const relativeVocal = songFiles.find(file => file.endsWith("reference-vocal.wav"));
if (!relativeVocal) throw new Error(`No reference-vocal.wav found under ${songRoot}`);
const referenceVocal = path.join(songRoot, relativeVocal);
const instrumental = path.join(path.dirname(referenceVocal), "instrumental.wav");
await fs.access(instrumental);
const artifactRoot = path.join(root, "AudioService", "build", "network-resilience-test");
await fs.mkdir(artifactRoot, { recursive: true });

const ids = ["resilience-A", "resilience-B", "resilience-C", "resilience-D"];
const participantKey = id => {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
};
const keys = new Map(ids.map(id => [participantKey(id), id]));
const songDurationSeconds = 28;
const songStartAtMs = Date.now() + 4_000;
const startedAt = performance.now() + 4_000;
const endpoints = new Map();
const timers = new Set();
const proxyMetrics = {
  forwarded: 0, outageDropped: 0, burstDropped: 0, queueOverflow: 0,
  corrupted: 0, stale: 0, wrongToken: 0, duplicated: 0, reordered: 0
};

const baseProfile = latencyMs => ({
  stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs }],
  jitterMs: 0, loss: 0, duplicate: 0
});
const profileFor = (source, destination) => {
  if (source === ids[0]) return {
    stages: [{ untilMs: 5_000, latencyMs: 20 }, { untilMs: 14_000, latencyMs: 100 },
      { untilMs: Number.POSITIVE_INFINITY, latencyMs: 30 }],
    jitterMs: 10, loss: 0.01, duplicate: 0.002, reorder: 0.005, driftPpm: 100,
    outages: [{ fromMs: 2_000, untilMs: 12_000 },
      ...(destination === ids[3]
        ? []
        : [{ fromMs: 15_000, untilMs: Number.POSITIVE_INFINITY }])]
  };
  if (source === ids[1]) return {
    ...baseProfile(35), burstLoss: { everyPackets: 20, lengthPackets: 5 },
    outages: destination === ids[3]
      ? []
      : [{ fromMs: 15_000, untilMs: Number.POSITIVE_INFINITY }]
  };
  if (source === ids[2]) return {
    ...baseProfile(55), bandwidthKbps: 32, queueLimitMs: 120,
    stalls: [{ fromMs: 7_000, untilMs: 7_020, delayMs: 20 },
      { fromMs: 9_000, untilMs: 9_500, delayMs: 500 }],
    outages: destination === ids[3]
      ? []
      : [{ fromMs: 15_000, untilMs: Number.POSITIVE_INFINITY }]
  };
  return {
    ...baseProfile(destination === ids[0] ? 180 : 15), jitterMs: 6, loss: 0.005,
    duplicate: 0.005, reorder: 0.005, corrupt: 0.001, stale: 0.001, wrongToken: 0.001
  };
};
const impairments = new Map();
const impairmentFor = (source, destination) => {
  const name = `${source}->${destination}`;
  if (!impairments.has(name)) {
    const seed = participantKey(source) ^ Math.imul(participantKey(destination), 2654435761);
    impairments.set(name, createImpairment(profileFor(source, destination), seed >>> 0));
  }
  return impairments.get(name);
};

const proxy = dgram.createSocket("udp4");
const schedule = (message, endpoint, delayMs) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    proxy.send(message, endpoint.port, endpoint.address);
  }, delayMs);
  timers.add(timer);
};
const mutatePacket = (message, impairment) => {
  const packet = Buffer.from(message);
  if (impairment.corrupted) { packet[0] ^= 0xff; proxyMetrics.corrupted += 1; }
  if (impairment.stale) {
    packet.writeUInt32LE((packet.readUInt32LE(8) - 100) >>> 0, 8);
    proxyMetrics.stale += 1;
  }
  if (impairment.wrongToken) {
    packet[16] ^= 0x01;
    proxyMetrics.wrongToken += 1;
  }
  return packet;
};
proxy.on("message", (message, sourceEndpoint) => {
  if (message.length < 40) return;
  const sourceKey = message.readUInt32LE(12);
  const sourceId = keys.get(sourceKey);
  if (!sourceId) return;
  endpoints.set(sourceKey, { address: sourceEndpoint.address, port: sourceEndpoint.port });
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  for (const [destinationKey, endpoint] of endpoints) {
    if (destinationKey === sourceKey) continue;
    const destinationId = keys.get(destinationKey);
    const impairment = impairmentFor(sourceId, destinationId)(elapsedMs, message.length);
    if (impairment.dropped) {
      if (profileFor(sourceId, destinationId).outages?.some(
        outage => elapsedMs >= outage.fromMs && elapsedMs < outage.untilMs))
        proxyMetrics.outageDropped += 1;
      else if (profileFor(sourceId, destinationId).burstLoss)
        proxyMetrics.burstDropped += 1;
      if (impairment.queueOverflow) proxyMetrics.queueOverflow += 1;
      continue;
    }
    const packet = mutatePacket(message, impairment);
    schedule(packet, endpoint, impairment.delayMs);
    proxyMetrics.forwarded += 1;
    if (impairment.duplicate) {
      schedule(packet, endpoint, impairment.delayMs + 1);
      proxyMetrics.duplicated += 1;
    }
    if (impairment.reordered) proxyMetrics.reordered += 1;
  }
});
await new Promise(resolve => proxy.bind(0, "127.0.0.1", resolve));

const processes = new Set();
const runClient = ({ id, startAtMs, offsetSeconds, durationSeconds, suffix = "",
  warmupSeconds = 2, stallAtMs = 0, stallDurationMs = 0 }) => {
  const output = path.join(artifactRoot, `${id}${suffix}.wav`);
  const remotes = ids.filter(remote => remote !== id).join(",");
  const child = spawn(executable, [
    "--network-test-client", "--input", referenceVocal, "--backing", instrumental,
    "--output", output,
    "--local-id", id, "--remote-id", remotes,
    "--remote-port", String(proxy.address().port), "--token", "123456789abcdef0",
    "--start-at-ms", String(startAtMs),
    "--media-offset-frames", String(offsetSeconds * 48_000),
    "--duration-seconds", String(durationSeconds),
    "--warmup-seconds", String(warmupSeconds),
    "--stall-at-ms", String(stallAtMs),
    "--stall-duration-ms", String(stallDurationMs)
  ], { windowsHide: true });
  processes.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => {
      processes.delete(child);
      if (code === 0) resolve({ report: JSON.parse(stdout), output });
      else reject(new Error(`${id}${suffix} exited ${code}: ${stderr || stdout}`));
    });
  });
  return { child, completion, output };
};
const delayUntil = target => new Promise(resolve => setTimeout(resolve, Math.max(0, target - Date.now())));

const readWavSegment = async (file, fromSecond, toSecond, channel = 0) => {
  const bytes = await fs.readFile(file);
  const channels = bytes.readUInt16LE(22);
  const rate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  if (bits !== 16) throw new Error(`Expected PCM16 evidence: ${file}`);
  let offset = 12, dataOffset = 0, dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "data") {
      dataOffset = offset + 8; dataBytes = size; break;
    }
    offset += 8 + size + (size & 1);
  }
  const first = Math.max(0, Math.floor(fromSecond * rate));
  const last = Math.min(dataBytes / (channels * 2), Math.floor(toSecond * rate));
  const samples = new Float32Array(Math.max(0, last - first));
  for (let frame = first; frame < last; frame += 1) {
    samples[frame - first] = bytes.readInt16LE(
      dataOffset + (frame * channels + Math.min(channel, channels - 1)) * 2) / 32768;
  }
  return { rate, samples };
};
const rms = samples => {
  let energy = 0, count = 0;
  for (let index = 0; index < samples.length; index += 16) {
    energy += samples[index] ** 2; count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count));
};
const recordedMixError = (backing, voice, mix) => {
  let maximum = 0, energy = 0;
  const count = Math.min(backing.length, voice.length, mix.length);
  for (let index = 0; index < count; index += 1) {
    const expected = Math.max(-1, Math.min(1, backing[index] + voice[index]));
    const error = Math.abs(mix[index] - expected);
    maximum = Math.max(maximum, error);
    energy += error ** 2;
  }
  return { maximum, rms: Math.sqrt(energy / Math.max(1, count)) };
};
const correlate = (left, right, maximumOffset = 480) => {
  const window = Math.min(left.length, right.length, 24_000);
  const candidates = [];
  for (let start = 0; start + window <= Math.min(left.length, right.length); start += window) {
    let leftEnergy = 0, rightEnergy = 0;
    for (let index = 0; index < window; index += 32) {
      leftEnergy += left[start + index] ** 2;
      rightEnergy += right[start + index] ** 2;
    }
    candidates.push({ start, energy: Math.sqrt(leftEnergy * rightEnergy) });
  }
  candidates.sort((a, b) => b.energy - a.energy);
  let best = { offsetSamples: 0, peakCorrelation: -1 };
  for (let shift = -maximumOffset; shift <= maximumOffset; shift += 1) {
    for (const candidate of candidates.slice(0, 8)) {
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

try {
  const steady = ids.slice(0, 3).map(id => runClient({
    id, startAtMs: songStartAtMs, offsetSeconds: 0, durationSeconds: songDurationSeconds,
    stallAtMs: id === ids[2] ? 9_000 : 0,
    stallDurationMs: id === ids[2] ? 500 : 0
  }));
  await delayUntil(songStartAtMs + 5_000);
  const late = runClient({ id: ids[3], startAtMs: songStartAtMs + 6_000,
    offsetSeconds: 6, durationSeconds: 6, suffix: "-late", warmupSeconds: 0 });
  await late.completion;
  await delayUntil(songStartAtMs + 14_000);
  const restarted = runClient({ id: ids[3], startAtMs: songStartAtMs + 15_000,
    offsetSeconds: 15, durationSeconds: songDurationSeconds - 15,
    suffix: "-restarted", warmupSeconds: 0 });
  const results = await Promise.all([...steady.map(item => item.completion), restarted.completion]);
  const steadyReports = results.slice(0, 3).map(item => item.report);
  const restartedReport = results.at(-1).report;
  const segments = await Promise.all(results.slice(0, 3).map(
    item => readWavSegment(item.output, 18, 24, 1)));
  const postRestartRms = rms(segments[0].samples);
  const audibleAlignment = [
    correlate(segments[0].samples, segments[1].samples),
    correlate(segments[0].samples, segments[2].samples),
    correlate(segments[1].samples, segments[2].samples)
  ];
  const [backingEvidence, voiceEvidence, mixEvidence] = await Promise.all([
    readWavSegment(results[0].output, 18, 24, 0),
    readWavSegment(results[0].output, 18, 24, 1),
    readWavSegment(results[0].output, 18, 24, 2)
  ]);
  const performanceEvidence = {
    path: results[0].output,
    backingRms: rms(backingEvidence.samples),
    voiceRms: rms(voiceEvidence.samples),
    mixRms: rms(mixEvidence.samples),
    recordedMixError: recordedMixError(
      backingEvidence.samples, voiceEvidence.samples, mixEvidence.samples)
  };
  const report = {
    seed: "participant-pair-derived", referenceVocal, proxyMetrics,
    steadyReports, lateReport: (await late.completion).report, restartedReport, postRestartRms,
    audibleAlignment, performanceEvidence
  };
  if (steadyReports.some(item => !item.transportRunning || !item.sendEnabled ||
      item.participants !== 3 || item.packetsSent === 0 || item.packetsReceived === 0 ||
      !item.stallRecovered) ||
      !restartedReport.transportRunning || restartedReport.mediaOffsetFrames !== 15 * 48_000 ||
      steadyReports.some(item => item.sharedTargetDelayFrames > 21_600 ||
        item.interPeerAlignmentErrorFrames > 9_600) ||
      proxyMetrics.outageDropped < 100 || proxyMetrics.burstDropped < 10 ||
      proxyMetrics.queueOverflow < 1 || proxyMetrics.forwarded < 100 ||
      postRestartRms < 0.0001 || audibleAlignment.some(
        item => Math.abs(item.offsetSamples) > 96 || item.peakCorrelation < 0.7) ||
      performanceEvidence.backingRms < 0.0001 || performanceEvidence.voiceRms < 0.0001 ||
      performanceEvidence.mixRms < 0.0001 || performanceEvidence.recordedMixError.maximum > 0.0001)
    throw new Error(`Resilience process scenario failed: ${JSON.stringify(report)}`);
  const reportPath = path.join(artifactRoot, "network-resilience-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }));
} finally {
  for (const timer of timers) clearTimeout(timer);
  proxy.close();
  for (const child of processes) child.kill();
}
