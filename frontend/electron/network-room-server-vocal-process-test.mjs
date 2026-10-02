import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomServerProxy } from "./room-network-proxy.mjs";
import { summarizeRoute } from "./room-network-stats.mjs";
import { measuredVoiceLatencyMs } from "./room-production-timing.mjs";
import { classifyRoomE2eFailure } from "./room-e2e-classification.mjs";
import { classifyLateCutPhase } from "./room-e2e-phase.mjs";
import { estimateOffsetMs } from "./room-audio-alignment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenario = process.argv[2] ?? "normal";
const seed = Number(process.argv.find(value => value.startsWith("--seed="))?.slice(7) ?? 0);
const scenarioDelays = {
  ideal: { upstream: 0, downstream: 0, jitter: 0 },
  normal: { upstream: 12, downstream: 18, jitter: 2 },
  wifi: { upstream: 20, downstream: 28, jitter: 8 },
  asymmetric: { upstream: 8, downstream: 34, jitter: 4 },
  spikes: { upstream: 15, downstream: 22, jitter: 18 },
  "near-deadline": { upstream: 25, downstream: 32, jitter: 3 },
  heterogeneous: { upstream: 12, downstream: 18, jitter: 2 },
};
if (!scenarioDelays[scenario]) throw new Error(`Unknown room E2E scenario: ${scenario}`);
const impairmentProfile = scenarioDelays[scenario];
const reserveMs = Number(process.env.ROOM_RETURN_RESERVE_MS ?? 10);
const audioExecutable = (await Promise.all(["AudioService\\build\\Release\\AudioService.exe", "AudioService\\build\\Debug\\AudioService.exe"].map(async item => {
  const candidate = path.join(root, item); return await fs.access(candidate).then(() => candidate).catch(() => null);
}))).find(Boolean);
if (!audioExecutable) throw new Error("Build AudioService before running the Room Server process test");
const songRoots = ["AD Voice Dev", "AD Voice Multi 2", "AD Voice", "ad-voice-frontend"]
  .map(profile => path.join(process.env.APPDATA ?? "", profile, "backend-data", "songs"));
let referenceVocal;
for (const songRoot of songRoots) {
  try { const songFiles = await fs.readdir(songRoot, { recursive: true }); const relative = songFiles.find(file => file.endsWith("reference-vocal.wav")); if (relative) { referenceVocal = path.join(songRoot, relative); break; } } catch { /* try the next profile */ }
}
if (!referenceVocal) throw new Error("No reference-vocal.wav found in any local application profile");
const backingTrack = path.join(path.dirname(referenceVocal), "instrumental.wav");
const artifactRoot = path.join(root, "artifacts", "room-e2e", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(artifactRoot, { recursive: true });
const pilotVocal = path.join(artifactRoot, "pilot-reference-vocal.wav");
const referenceBytes = await fs.readFile(referenceVocal);
const pilotBytes = Buffer.from(referenceBytes);
let pilotOffset = 12, pilotDataOffset = 0, pilotDataSize = 0;
while (pilotOffset + 8 <= pilotBytes.length) { const id = pilotBytes.toString("ascii", pilotOffset, pilotOffset + 4); const size = pilotBytes.readUInt32LE(pilotOffset + 4); if (id === "data") { pilotDataOffset = pilotOffset + 8; pilotDataSize = size; break; } pilotOffset += 8 + size + (size & 1); }
for (let frame = 0; frame + 1 < pilotDataSize / 2; frame += 24_000) { const index = pilotDataOffset + frame * 2; pilotBytes.writeInt16LE(Math.max(-32768, Math.min(32767, pilotBytes.readInt16LE(index) + 12_000)), index); }
await fs.writeFile(pilotVocal, pilotBytes);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "room-server-e2e-"));
const freePort = async () => { const { createServer } = await import("node:net"); const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const httpPort = await freePort();
const relayPort = await freePort();
const python = path.join(root, "python", ".venv", "Scripts", "python.exe");
const server = spawn(python, ["-m", "backend.room_server_main"], { cwd: path.join(root, "python"), windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, "python"), AD_VOICE_ROOM_SERVER_PORT: String(httpPort), AD_VOICE_ROOM_SERVER_RELAY_PORT: String(relayPort), AD_VOICE_ROOM_SERVER_DATA: tempRoot, AD_VOICE_RETURN_ROUTE_RESERVE_MS: String(reserveMs) } });
server.stderr.on("data", chunk => process.stderr.write(`[room-server] ${chunk}`));
const stop = child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); child.kill(); });
const request = async (url, options) => { const response = await fetch(`http://127.0.0.1:${httpPort}${url}`, { ...options, signal: AbortSignal.timeout(5_000) }); if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url}: ${response.status} ${await response.text()}`); return response.status === 204 ? null : response.json(); };
let ready = false;
for (let attempt = 0; attempt < 80; attempt++) { try { await request("/health/ready"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
if (!ready) throw new Error(`Room Server did not become ready on ${httpPort}`);
console.error(`Room Server ready on ${httpPort}, relay ${relayPort}`);
const json = body => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const participantA = "room-process-A", participantB = "room-process-B", participantC = "room-process-C";
const room = await request("/rooms", { method: "POST", ...json({ participantId: participantA, displayName: "A" }) });
console.error(`Room created: ${room.roomId}`);
await request(`/rooms/${room.roomId}/join`, { method: "POST", ...json({ participantId: participantB, displayName: "B" }) });
if (scenario === "heterogeneous") await request(`/rooms/${room.roomId}/join`, { method: "POST", ...json({ participantId: participantC, displayName: "C" }) });
console.error("Room joined");
const tokenA = await request("/voice/join", { method: "POST", ...json({ roomId: room.roomId, participantId: participantA, machineId: "room-e2e-A" }) });
console.error("Voice A joined");
const tokenB = await request("/voice/join", { method: "POST", ...json({ roomId: room.roomId, participantId: participantB, machineId: "room-e2e-B" }) });
console.error("Voice B joined");
console.error(`Tokens: ${tokenA.voiceToken} ${tokenB.voiceToken}`);
if (scenario === "heterogeneous") await request("/voice/join", { method: "POST", ...json({ roomId: room.roomId, participantId: participantC, machineId: "room-e2e-C" }) });
let impairmentTick = Number.isFinite(seed) ? seed : 0;
const proxy = await createRoomServerProxy({ serverPort: relayPort, impair: direction => {
  const jitter = impairmentProfile.jitter === 0 ? 0 : ((impairmentTick++ % 5) - 2) * impairmentProfile.jitter / 2;
  return { delayMs: Math.max(0, impairmentProfile[direction] + jitter), dropped: false };
} });
console.error(`Proxy ready on ${proxy.port}`);
// The Room Server emits a per-recipient mix-minus stream under this reserved remote id.
const clients = [{ id: participantA, remote: "__room_server_mix__", token: tokenA.voiceToken, output: path.join(artifactRoot, "client-a.wav") }, { id: participantB, remote: "__room_server_mix__", token: tokenB.voiceToken, output: path.join(artifactRoot, "client-b.wav") }];
const run = (client, startAtMs, durationSeconds, roomDelayMs = 0, roomServerUnixMs = Date.now()) => new Promise((resolve, reject) => { const child = spawn(audioExecutable, ["--network-test-client", "--input", pilotVocal, ...(backingTrack ? ["--backing", backingTrack] : []), "--output", client.output, "--local-id", client.id, "--remote-id", client.remote, "--remote-port", String(proxy.port), "--token", client.token, "--start-at-ms", String(startAtMs), "--room-server-unix-ms", String(roomServerUnixMs), "--duration-seconds", String(durationSeconds), "--warmup-seconds", "0", ...(roomDelayMs ? ["--room-playout-delay-ms", String(Math.round(roomDelayMs))] : [])], { windowsHide: true }); let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("exit", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${client.id} exited ${code}: ${stderr || stdout}`))); });
const readWav = async file => {
  const bytes = await fs.readFile(file); let offset = 12, channels = 0, rate = 0, data;
  while (offset + 8 <= bytes.length) { const id = bytes.toString("ascii", offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); if (id === "fmt ") { channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); } if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size); offset += 8 + size + (size & 1); }
  if (!data || !channels || !rate) throw new Error(`Invalid WAV evidence: ${file}`);
  const samples = Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768);
  const channel = index => samples.filter((_, sample) => sample % channels === index);
  const levels = Array.from({ length: channels }, (_, index) => { const values = channel(index); let energy = 0, peak = 0; for (const value of values) { energy += value * value; peak = Math.max(peak, Math.abs(value)); } return { rms: Math.sqrt(energy / Math.max(1, values.length)), peak }; });
  return { channels, rate, channel, levels };
};
const pilotMarkers = samples => {
  const markers = [];
  let active = false, start = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const loud = Math.abs(samples[index]) > 0.02;
    if (loud && !active) { active = true; start = index; }
    if (!loud && active) { if (index - start >= 2) markers.push(Math.floor((start + index) / 2)); active = false; }
  }
  return markers;
};
const markerSkew = (left, right, rate) => {
  const a = pilotMarkers(left), b = pilotMarkers(right);
  const count = Math.min(a.length, b.length);
  if (!count) return { offsetMs: null, correlation: 0, markers: [a.length, b.length] };
  const offsets = Array.from({ length: count }, (_, index) => b[index] - a[index]).sort((x, y) => x - y);
  return { offsetMs: offsets[Math.floor(offsets.length / 2)] * 1000 / rate, correlation: 1, markers: [a.length, b.length] };
};
try {
  console.error("Starting AudioService clients");
  const startLeadMs = Number(process.env.ROOM_E2E_START_LEAD_MS ?? 3_000);
  const warmupStartAtMs = Date.now() + startLeadMs;
  const warmupReports = await Promise.all(clients.map(client => run(client, warmupStartAtMs, 1, 0, warmupStartAtMs)));
  const measuredUpstream = summarizeRoute({ samples: proxy.routeSamples.upstream, deadlineMs: 60 });
  const measuredDownstream = summarizeRoute({ samples: proxy.routeSamples.downstream, deadlineMs: 60 });
  const measuredRequestedVoiceLatencyMs = measuredVoiceLatencyMs({ upstreamP95Ms: measuredUpstream.p95Ms ?? 0, downstreamP95Ms: measuredDownstream.p95Ms ?? 0 });
  const requestedVoiceLatencyMs = Number(process.env.ROOM_E2E_REQUESTED_VOICE_LATENCY_MS ?? measuredRequestedVoiceLatencyMs);
  await request(`/rooms/${room.roomId}/timing`, { method: "POST", ...json({ participantId: participantA, voiceLatencyMs: requestedVoiceLatencyMs }) });
  await request(`/rooms/${room.roomId}/timing`, { method: "POST", ...json({ participantId: participantB, voiceLatencyMs: requestedVoiceLatencyMs }) });
  if (scenario === "heterogeneous") await request(`/rooms/${room.roomId}/timing`, { method: "POST", ...json({ participantId: participantC, voiceLatencyMs: 90 }) });
  const roomState = await request(`/rooms/${room.roomId}`);
  const mainStartAtMs = Date.now() + startLeadMs;
  const processReports = await Promise.all(clients.map(client => run(client, mainStartAtMs, 4, roomState.roomPlayoutDelayMs, mainStartAtMs)));
  const relayMetrics = await request("/voice/metrics", { method: "POST", ...json({ roomId: room.roomId, participantId: participantA, voiceToken: tokenA.voiceToken }) });
  const rendered = await Promise.all(clients.map(client => readWav(client.output)));
  const reference = await readWav(referenceVocal);
  const backingSkew = estimateOffsetMs(rendered[0].channel(0), rendered[1].channel(0), rendered[0].rate);
  const remoteVocalSkew = markerSkew(rendered[0].channel(1), rendered[1].channel(1), rendered[0].rate);
  const upstream = summarizeRoute({ samples: proxy.routeSamples.upstream, deadlineMs: roomState.roomPlayoutDelayMs });
  const downstream = summarizeRoute({ samples: proxy.routeSamples.downstream, deadlineMs: roomState.roomPlayoutDelayMs });
  const routeP95Ms = (upstream.p95Ms ?? 0) + (downstream.p95Ms ?? 0);
  const participants = Object.fromEntries(roomState.participants.map(item => [item.participantId, { voiceLatencyMs: item.voiceLatencyMs, voiceEligible: item.voiceEligible, voiceTimingReady: item.voiceTimingReady }]));
  const heterogeneousPass = scenario !== "heterogeneous" || (participants[participantC]?.voiceEligible === false && participants[participantA]?.voiceEligible === true && participants[participantB]?.voiceEligible === true);
  const audioAlignment = { backingSkewMs: backingSkew.offsetMs, remoteVocalSkewMs: remoteVocalSkew.offsetMs, backingCorrelation: backingSkew.correlation, remoteVocalCorrelation: remoteVocalSkew.correlation, levels: rendered.map(item => item.levels) };
  const audioAligned = audioAlignment.backingSkewMs !== null && audioAlignment.remoteVocalSkewMs !== null && Math.abs(audioAlignment.backingSkewMs) <= 10 && Math.abs(audioAlignment.remoteVocalSkewMs) <= 10;
  const routes = { upstream, downstream, totalP95Ms: routeP95Ms, deadlineMarginMs: roomState.roomPlayoutDelayMs - routeP95Ms };
  const lateCutPhases = processReports.map(item => ({ participantId: item.participantId, lateAudioCuts: item.lateAudioCuts, firstFrame: item.firstLateAudioCutFrame, lastFrame: item.lastLateAudioCutFrame, firstPhase: item.firstLateAudioCutFrame ? classifyLateCutPhase(item.firstLateAudioCutFrame, 4) : null, lastPhase: item.lastLateAudioCutFrame ? classifyLateCutPhase(item.lastLateAudioCutFrame, 4) : null }));
  const failureReason = classifyRoomE2eFailure({ audioAlignment, relayMetrics, routes, processReports, lateCutPhases });
  const mainStartFrame = mainStartAtMs * 48;
  const exclusionPhases = (relayMetrics.exclusion_trace ?? []).map(item => ({ ...item, phase: item.position < mainStartFrame + 4_800 ? "STARTUP" : item.position >= mainStartFrame + 4 * 48_000 - 4_800 ? "DRAIN" : "ACTIVE" }));
  const trace = relayMetrics.position_trace ?? [];
  const ingressTrace = relayMetrics.ingress_trace ?? [];
  const activeSlackSamples = (relayMetrics.collection_slack_samples ?? []).filter(item => item.position >= mainStartFrame + 4_800 && item.position < mainStartFrame + 4 * 48_000 - 4_800);
  const collectionSlack = Object.fromEntries([...new Set(activeSlackSamples.map(item => item.participant))].map(participant => {
    const values = activeSlackSamples.filter(item => item.participant === participant).map(item => item.slack_ms).sort((a, b) => a - b);
    const percentile = fraction => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] : null;
    return [participant, { samples: values.length, p50Ms: percentile(0.5), p5Ms: percentile(0.05), minMs: values[0] ?? null, afterClose: values.filter(value => value < 0).length, afterClosePercent: values.length ? values.filter(value => value < 0).length / values.length * 100 : 0 }];
  }));
  const firstActivePartialIndex = trace.findIndex(item => !item.complete && item.position >= mainStartFrame + 4_800 && item.position < mainStartFrame + 4 * 48_000 - 4_800);
  const firstActivePartial = firstActivePartialIndex < 0 ? null : (() => {
    const item = trace[firstActivePartialIndex];
    const window = trace.slice(Math.max(0, firstActivePartialIndex - 5), firstActivePartialIndex + 11).map(position => ({
      ...position,
      ingress: ingressTrace.filter(packet => packet.bin_start === position.position),
    }));
    const currentIngress = window.find(position => position.position === item.position)?.ingress ?? [];
    const missing = item.missing.map(participant => {
      const exact = currentIngress.filter(packet => packet.participant === participant && packet.timestamp === item.position);
      const nearby = ingressTrace.filter(packet => packet.participant === participant && Math.abs(packet.timestamp - item.position) <= 1_000);
      const classification = exact.length === 0 ? (nearby.length === 0 ? "PARTIAL_NO_INGRESS" : "PARTIAL_TIMESTAMP_MISMATCH") : exact.every(packet => item.deadline_now !== null && packet.arrival_now > item.deadline_now) ? "PARTIAL_ARRIVED_AFTER_CLOSE" : "PARTIAL_NOT_INSERTED";
      return { participant, classification, exact, nearby };
    });
    return { position: item.position, expected: item.expected, received: item.received, missing, window };
  })();
  const proxyPacketSummary = proxy.packetTrace.reduce((summary, item) => {
    const key = `${item.direction}:${item.dropped ? "dropped" : "forwarded"}`;
    summary[key] = (summary[key] ?? 0) + 1;
    return summary;
  }, {});
  const report = { scenario, seed, reserveMs, timingHandshake: true, appliedToAudioService: true, measured: { warmupReports, requestedVoiceLatencyMs, upstream: measuredUpstream, downstream: measuredDownstream }, participants, relayMetrics, mainStartFrame, exclusionPhases, collectionSlack, firstActivePartial, roomId: room.roomId, server: `http://127.0.0.1:${httpPort}`, relayPort, route: "client -> Room Server UDP relay -> client", targetDelayMs: roomState.roomPlayoutDelayMs, proxyPackets: { upstream: proxy.upstreamPackets, downstream: proxy.downstreamPackets, trace: proxy.packetTrace, summary: proxyPacketSummary }, routes, audioAlignment, processReports, lateCutPhases, failureReason, result: heterogeneousPass && audioAligned && !["NETWORK_DEADLINE_MISS", "SERVER_MIX_EMPTY", "SERVER_MIX_INCOMPLETE", "PILOT_NOT_DETECTED", "ALIGNMENT_EXCEEDED", "DELIVERY_FAILURE", "MUSICAL_POSITION_MISMATCH"].includes(failureReason) && processReports.every(item => item.packetsReceived > 0 && item.roomPlayoutDelayMs === Math.round(roomState.roomPlayoutDelayMs)) ? "PASS" : "FAIL", referenceVocal, backingTrack, artifactRoot };
  await fs.writeFile(path.join(artifactRoot, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(artifactRoot, "report.md"), `# Room Server vocal process test\n\n- Route: client → Room Server → client\n- Room: ${room.roomId}\n- Scenario: ${scenario}\n- Selected Room Server deadline: ${roomState.roomPlayoutDelayMs} ms\n- Applied AudioService deadline: ${report.processReports.map(item => item.roomPlayoutDelayMs).join(" / ")} ms\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`, "utf8");
  console.log(JSON.stringify(report));
} catch (error) { console.error(`Proxy packets upstream=${proxy.upstreamPackets} downstream=${proxy.downstreamPackets}`); throw error; }
finally { await proxy.close(); await stop(server); }
