import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomServerProxy } from "./room-network-proxy.mjs";
import { summarizeRoute } from "./room-network-stats.mjs";
import { measuredVoiceLatencyMs } from "./room-production-timing.mjs";
import { estimateOffsetMs } from "./room-audio-alignment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenario = process.argv[2] ?? "normal";
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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "room-server-e2e-"));
const freePort = async () => { const { createServer } = await import("node:net"); const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const httpPort = await freePort();
const relayPort = await freePort();
const python = path.join(root, "python", ".venv", "Scripts", "python.exe");
const server = spawn(python, ["-m", "backend.room_server_main"], { cwd: path.join(root, "python"), windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, "python"), AD_VOICE_ROOM_SERVER_PORT: String(httpPort), AD_VOICE_ROOM_SERVER_RELAY_PORT: String(relayPort), AD_VOICE_ROOM_SERVER_DATA: tempRoot } });
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
let impairmentTick = 0;
const proxy = await createRoomServerProxy({ serverPort: relayPort, impair: direction => {
  const jitter = impairmentProfile.jitter === 0 ? 0 : ((impairmentTick++ % 5) - 2) * impairmentProfile.jitter / 2;
  return { delayMs: Math.max(0, impairmentProfile[direction] + jitter), dropped: false };
} });
console.error(`Proxy ready on ${proxy.port}`);
// The Room Server emits a per-recipient mix-minus stream under this reserved remote id.
const clients = [{ id: participantA, remote: "__room_server_mix__", token: tokenA.voiceToken, output: path.join(artifactRoot, "client-a.wav") }, { id: participantB, remote: "__room_server_mix__", token: tokenB.voiceToken, output: path.join(artifactRoot, "client-b.wav") }];
const run = (client, durationSeconds, roomDelayMs = 0) => new Promise((resolve, reject) => { const child = spawn(audioExecutable, ["--network-test-client", "--input", referenceVocal, ...(backingTrack ? ["--backing", backingTrack] : []), "--output", client.output, "--local-id", client.id, "--remote-id", client.remote, "--remote-port", String(proxy.port), "--token", client.token, "--start-at-ms", String(Date.now() + 1_000), "--duration-seconds", String(durationSeconds), "--warmup-seconds", "0", ...(roomDelayMs ? ["--room-playout-delay-ms", String(Math.round(roomDelayMs))] : [])], { windowsHide: true }); let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("exit", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${client.id} exited ${code}: ${stderr || stdout}`))); });
const readWav = async file => {
  const bytes = await fs.readFile(file); let offset = 12, channels = 0, rate = 0, data;
  while (offset + 8 <= bytes.length) { const id = bytes.toString("ascii", offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); if (id === "fmt ") { channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); } if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size); offset += 8 + size + (size & 1); }
  if (!data || !channels || !rate) throw new Error(`Invalid WAV evidence: ${file}`);
  const samples = Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768);
  return { channels, rate, channel: index => samples.filter((_, sample) => sample % channels === index) };
};
try {
  console.error("Starting AudioService clients");
  const warmupReports = await Promise.all(clients.map(client => run(client, 1)));
  const measuredUpstream = summarizeRoute({ samples: proxy.routeSamples.upstream, deadlineMs: 60 });
  const measuredDownstream = summarizeRoute({ samples: proxy.routeSamples.downstream, deadlineMs: 60 });
  const requestedVoiceLatencyMs = measuredVoiceLatencyMs({ upstreamP95Ms: measuredUpstream.p95Ms ?? 0, downstreamP95Ms: measuredDownstream.p95Ms ?? 0 });
  await request(`/rooms/${room.roomId}/timing`, { method: "POST", ...json({ participantId: participantA, voiceLatencyMs: requestedVoiceLatencyMs }) });
  await request(`/rooms/${room.roomId}/timing`, { method: "POST", ...json({ participantId: participantB, voiceLatencyMs: requestedVoiceLatencyMs }) });
  if (scenario === "heterogeneous") await request(`/rooms/${room.roomId}/timing`, { method: "POST", ...json({ participantId: participantC, voiceLatencyMs: 90 }) });
  const roomState = await request(`/rooms/${room.roomId}`);
  const processReports = await Promise.all(clients.map(client => run(client, 4, roomState.roomPlayoutDelayMs)));
  const rendered = await Promise.all(clients.map(client => readWav(client.output)));
  const backingSkew = estimateOffsetMs(rendered[0].channel(0), rendered[1].channel(0), rendered[0].rate);
  const remoteVocalSkew = estimateOffsetMs(rendered[0].channel(1), rendered[1].channel(1), rendered[0].rate);
  const upstream = summarizeRoute({ samples: proxy.routeSamples.upstream, deadlineMs: roomState.roomPlayoutDelayMs });
  const downstream = summarizeRoute({ samples: proxy.routeSamples.downstream, deadlineMs: roomState.roomPlayoutDelayMs });
  const routeP95Ms = (upstream.p95Ms ?? 0) + (downstream.p95Ms ?? 0);
  const participants = Object.fromEntries(roomState.participants.map(item => [item.participantId, { voiceLatencyMs: item.voiceLatencyMs, voiceEligible: item.voiceEligible, voiceTimingReady: item.voiceTimingReady }]));
  const heterogeneousPass = scenario !== "heterogeneous" || (participants[participantC]?.voiceEligible === false && participants[participantA]?.voiceEligible === true && participants[participantB]?.voiceEligible === true);
  const audioAlignment = { backingSkewMs: backingSkew.offsetMs, remoteVocalSkewMs: remoteVocalSkew.offsetMs, backingCorrelation: backingSkew.correlation, remoteVocalCorrelation: remoteVocalSkew.correlation };
  const audioAligned = Math.abs(audioAlignment.backingSkewMs) <= 10 && Math.abs(audioAlignment.remoteVocalSkewMs) <= 10;
  const report = { scenario, timingHandshake: true, appliedToAudioService: true, measured: { warmupReports, requestedVoiceLatencyMs, upstream: measuredUpstream, downstream: measuredDownstream }, participants, roomId: room.roomId, server: `http://127.0.0.1:${httpPort}`, relayPort, route: "client -> Room Server UDP relay -> client", targetDelayMs: roomState.roomPlayoutDelayMs, proxyPackets: { upstream: proxy.upstreamPackets, downstream: proxy.downstreamPackets }, routes: { upstream, downstream, totalP95Ms: routeP95Ms, deadlineMarginMs: roomState.roomPlayoutDelayMs - routeP95Ms }, audioAlignment, processReports, result: heterogeneousPass && audioAligned && processReports.every(item => item.packetsReceived > 0 && item.lateAudioCuts === 0 && item.packetsReceived >= item.packetsSent * 0.95 && item.roomPlayoutDelayMs === Math.round(roomState.roomPlayoutDelayMs)) && roomState.roomPlayoutDelayMs >= routeP95Ms ? "PASS" : "FAIL", referenceVocal, backingTrack, artifactRoot };
  await fs.writeFile(path.join(artifactRoot, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(artifactRoot, "report.md"), `# Room Server vocal process test\n\n- Route: client → Room Server → client\n- Room: ${room.roomId}\n- Scenario: ${scenario}\n- Selected Room Server deadline: ${roomState.roomPlayoutDelayMs} ms\n- Applied AudioService deadline: ${report.processReports.map(item => item.roomPlayoutDelayMs).join(" / ")} ms\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`, "utf8");
  console.log(JSON.stringify(report));
} catch (error) { console.error(`Proxy packets upstream=${proxy.upstreamPackets} downstream=${proxy.downstreamPackets}`); throw error; }
finally { await proxy.close(); await stop(server); }
