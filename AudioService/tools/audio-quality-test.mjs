// Hardware quality gate around the production AudioService. The room plan is kept
// separate from local results; room execution requires the UI gate in AGENTS.md.
// Usage: node AudioService/tools/audio-quality-test.mjs --local [--stress]
//        node AudioService/tools/audio-quality-test.mjs --room [--stress]
//        node AudioService/tools/audio-quality-test.mjs --all [--stress]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const mode = args.includes("--all") ? "all" : args.includes("--room") ? "room" : "local";
const stress = args.includes("--stress") || mode === "all";
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const seed = Number(value("--seed", 12345));
const seconds = Math.max(2, Number(value("--seconds", 5)));
const outputIndex = args.indexOf("--out");
const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] :
  path.join(root, "artifacts", "audio-quality", new Date().toISOString().replaceAll(":", "-")));
const binaries = {
  service: process.env.AD_VOICE_AUDIO_SERVICE ?? path.join(root, "AudioService", "build", "Release", "AudioService.exe"),
  python: process.env.AD_VOICE_PYTHON ?? "python",
};
const profiles = [
  { name: "normal", backend: "wasapi-shared" },
  { name: "low-end-cpu", backend: "wasapi-shared", affinity: 1 },
  { name: "cpu-saturation", backend: "wasapi-shared", affinity: 1, cpuWorkers: 1 },
  { name: "memory-pressure", backend: "wasapi-shared", memoryMb: 128 },
  { name: "scheduler-jitter", backend: "wasapi-shared", affinity: 1, cpuWorkers: 1, burst: true },
  { name: "buffer-pressure", backend: "wasapi-shared", affinity: 1, cpuWorkers: 2 },
  { name: "combined-stress", backend: "wasapi-shared", affinity: 1, cpuWorkers: 2, memoryMb: 128 },
  { name: "long-running", backend: "wasapi-shared", durationSeconds: 60 },
  { name: "wasapi-exclusive", backend: "wasapi-exclusive" },
  { name: "device-lost-recovery", backend: "wasapi-shared", recovery: true },
  { name: "concurrent-recording", backend: "wasapi-shared" },
];
const roomProfiles = [
  { name: "normal", participants: 2 },
  { name: "weak-host", participants: 2, weak: [0] },
  { name: "weak-guest", participants: 2, weak: [1] },
  { name: "two-weak", participants: 2, weak: [0, 1] },
  { name: "three-participants", participants: 3 },
  { name: "four-mixed", participants: 4, weak: [0, 2] },
  { name: "network-jitter-loss", participants: 4, loss: 0.01, jitterMs: 12 },
];
const requestedScenario = value("--scenario", null);
const chosenLocal = (stress ? profiles : profiles.filter(p =>
  ["normal", "wasapi-exclusive", "device-lost-recovery", "concurrent-recording"].includes(p.name)))
  .filter(p => !requestedScenario || p.name === requestedScenario);
const chosenRoom = (stress ? roomProfiles : roomProfiles.filter(p => p.name === "normal"))
  .filter(p => !requestedScenario || p.name === requestedScenario);
const plan = { mode, seed, seconds, scenarios: [
  ...(mode === "room" ? [] : chosenLocal.map(p => ({ mode: "local", ...p }))),
  ...(mode === "local" ? [] : chosenRoom.map(p => ({ mode: "room", ...p }))),
] };
if (!plan.scenarios.length) throw new Error(`Unknown scenario: ${requestedScenario}`);
if (args.includes("--plan")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const parse = text => Object.fromEntries(text.replace(/^0\|/, "").split(/\r?\n/).map(line => {
  const colon = line.indexOf(": ");
  return colon < 0 ? null : [line.slice(0, colon), line.slice(colon + 2)];
}).filter(Boolean));
const pcmWav = (file, samples, rate = 48000, channels = 2) => {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, at) => data.writeInt16LE(Math.max(-32768, Math.min(32767,
    Math.round(sample * 32767))), at * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(data.length + 36, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
};
const stimulus = frames => {
  const state = (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
  const harmonicHz = 499 + state % 31;
  const samples = [];
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / 48000;
    const sample = 0.22 * Math.sin(2 * Math.PI * (231 * t + 29 * t * t))
      + 0.07 * Math.sin(2 * Math.PI * harmonicHz * t);
    samples.push(sample, sample);
  }
  return samples;
};
if (args.includes("--source-only")) {
  pcmWav(path.resolve(value("--source-only", "source.wav")), stimulus(48000));
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("The production backend quality gate requires Windows");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "plan.json"), JSON.stringify(plan, null, 2));
const request = (pipe, command, values = {}) => new Promise((resolve, reject) => {
  const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`);
  const line = ["1", command, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("|");
  let reply = "";
  socket.once("connect", () => socket.write(line + "\n"));
  socket.on("data", chunk => { reply += chunk.toString("utf8"); });
  socket.once("close", () => reply.startsWith("0|") ? resolve(reply.slice(2)) : reject(new Error(reply.trim())));
  socket.once("error", reject);
});
const audio = async (pipe, command, values = {}) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return await request(pipe, command, values); }
    catch (error) {
      if (attempt === 59 || !String(error).includes("ENOENT")) throw error;
      await delay(100);
    }
  }
};
const processSample = pid => {
  const script = `(Get-Process -Id ${pid} -ErrorAction Stop | Select-Object CPU,WorkingSet64) | ConvertTo-Json -Compress`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  return run.status === 0 ? JSON.parse(run.stdout) : null;
};
const setAffinity = (pid, mask) => {
  const run = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessorAffinity = ${mask}`],
  { encoding: "utf8", windowsHide: true });
  return run.status === 0 ? null : run.stderr.trim();
};
const startLoad = profile => {
  const loads = [];
  for (let index = 0; index < (profile.cpuWorkers ?? 0); index++) {
    const work = `let x=${seed + index};const work=()=>{for(let i=0;i<1000000;i++)x=(Math.imul(x,1664525)+1013904223)|0;};`;
    const code = profile.burst ? `${work}setInterval(()=>{const end=Date.now()+18;while(Date.now()<end)work();},40);`
      : `${work}for(;;)work();`;
    const child = spawn(process.execPath, ["-e", code], { windowsHide: true, stdio: "ignore" });
    if (profile.affinity) setAffinity(child.pid, profile.affinity);
    loads.push(child);
  }
  if (profile.memoryMb) {
    const amount = Math.min(profile.memoryMb, Math.floor(os.freemem() / (1024 * 1024 * 8)));
    const code = `const b=Buffer.alloc(${amount}*1048576);for(let i=0;i<b.length;i+=4096)b[i]=1;setInterval(()=>{},1000);`;
    loads.push(spawn(process.execPath, ["-e", code], { windowsHide: true, stdio: "ignore" }));
  }
  return loads;
};
const convertCapture = (directory, prefix) => {
  const metadata = readdirSync(directory).find(name => name.startsWith(prefix + "-") && name.endsWith(".csv")
    && !name.endsWith("-queue.csv") && !name.endsWith("-starve.csv"));
  if (!metadata) return null;
  const stem = metadata.slice(0, -4);
  const header = readFileSync(path.join(directory, metadata), "utf8").split(/\r?\n/)[0];
  const fields = Object.fromEntries(header.slice(1).split(",").map(field => field.split("=")));
  const raw = readFileSync(path.join(directory, stem + ".pcm"));
  const channels = Number(fields.channels), rate = Number(fields.sampleRate);
  const stride = { Float32: 4, Int16: 2, Int32: 4 }[fields.format];
  if (!stride || !channels || !rate) return null;
  const samples = [];
  for (let at = 0; at + stride <= raw.length; at += stride)
    samples.push(fields.format === "Float32" ? raw.readFloatLE(at)
      : fields.format === "Int16" ? raw.readInt16LE(at) / 32768
        : raw.readInt32LE(at) / 2147483648);
  const destination = path.join(directory, "actual.wav");
  pcmWav(destination, samples, rate, channels);
  return { destination, metadata, rate, channels, frames: samples.length / channels };
};
const runLocal = async profile => {
  const directory = path.join(output, "local", profile.name);
  mkdirSync(directory, { recursive: true });
  const duration = profile.durationSeconds ?? seconds;
  const report = { mode: "local", profile, seed, durationSeconds: duration,
    status: "INCONCLUSIVE", reasons: [], startedAt: new Date().toISOString() };
  writeFileSync(path.join(directory, "load.json"), JSON.stringify({ profile, seed }, null, 2));
  if (!existsSync(binaries.service)) {
    report.reasons.push(`AudioService executable absent: ${binaries.service}`);
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    return report;
  }
  const source = path.join(directory, "source.wav");
  const reference = path.join(directory, "reference-window.wav");
  pcmWav(source, stimulus((duration + 2) * 48000));
  pcmWav(reference, stimulus(48000));
  const pipe = `ADVoice.AudioQuality.${process.pid}.${profile.name}`;
  const prefix = "render";
  const child = spawn(binaries.service, [], { windowsHide: true, stdio: "ignore",
    env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: `\\\\.\\pipe\\${pipe}`,
      AD_VOICE_WASAPI_DIAGNOSTIC_PCM_PATH: path.join(directory, prefix),
      AD_VOICE_WASAPI_DIAGNOSTIC_PCM_MAX_FRAMES: String((duration + 2) * 48000) } });
  const loads = startLoad(profile);
  const began = Date.now();
  const schedulerDelays = [];
  let nextTick = Date.now() + 100;
  const timer = setInterval(() => {
    const now = Date.now();
    schedulerDelays.push(Math.max(0, now - nextTick));
    nextTick = now + 100;
  }, 100);
  try {
    if (profile.affinity) {
      const error = setAffinity(child.pid, profile.affinity);
      if (error) report.reasons.push(`CPU affinity unavailable: ${error}`);
    }
    const beforeCpu = processSample(child.pid);
    await audio(pipe, "Reconfigure", { backend: profile.backend, input: "", output: "",
      rate: 48000, period: 0, inChannels: 1, outChannels: 2 });
    await audio(pipe, "StartSession");
    await audio(pipe, "SetMicrophoneEnabled", { enabled: false });
    await audio(pipe, "SetMonitoring", { enabled: true });
    await audio(pipe, "LoadSong", { instrumental: source });
    await audio(pipe, "PrepareRecording", { id: profile.name,
      path: path.join(directory, "performance.wav"), tap: "performance" });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const playback = Number(parse(await audio(pipe, "GetDiagnostics")).PlaybackState);
      if ([2, 4, 6].includes(playback)) { ready = true; break; }
      if (playback === 7) throw new Error("backing decoder failed");
      await delay(100);
    }
    if (!ready) throw new Error("backing decoder did not become ready in 10 seconds");
    await audio(pipe, "Play", { context: "karaoke" });
    await audio(pipe, "StartRecording");
    await delay(1400); // one full music-only reference window before unknown microphone audio
    await audio(pipe, "SetMicrophoneEnabled", { enabled: true });
    await audio(pipe, "SetDspEnabled", { enabled: true });
    await audio(pipe, "SetDspParameter", { name: "compressor.threshold", value: 0.5 });
    await audio(pipe, "SetGain", { target: "mic", value: 0.7 });
    await audio(pipe, "SetGain", { target: "music", value: 0.8 });
    await audio(pipe, "SetMicrophoneEnabled", { enabled: false });
    await delay(200);
    await audio(pipe, "SetMicrophoneEnabled", { enabled: true });
    await delay(Math.max(500, (duration - 2) * 1000));
    report.diagnostics = parse(await audio(pipe, "GetDiagnostics"));
    writeFileSync(path.join(directory, "diagnostics.json"), JSON.stringify(report.diagnostics, null, 2));
    await audio(pipe, "StopRecording");
    if (profile.recovery) {
      await audio(pipe, "RecoverSession");
      report.afterRecovery = parse(await audio(pipe, "GetDiagnostics"));
    }
    await audio(pipe, "StopSession");
    const afterCpu = processSample(child.pid);
    report.resource = { before: beforeCpu, after: afterCpu,
      elapsedMs: Date.now() - began,
      cpuPercentOfOneCore: beforeCpu && afterCpu ?
        100 * (afterCpu.CPU - beforeCpu.CPU) * 1000 / (Date.now() - began) : null,
      loadProcesses: loads.map(load => ({ pid: load.pid, sample: processSample(load.pid) })),
      controllerSchedulerDelayMaxMs: Math.max(0, ...schedulerDelays) };
    const actual = convertCapture(directory, prefix);
    report.capture = actual;
    if (actual) {
      const oracleDir = path.join(directory, "backing-oracle");
      const result = spawnSync(binaries.python, [path.join(root, "AudioService", "tools", "pcm-continuity.py"),
        "compare", reference, actual.destination, oracleDir], { encoding: "utf8", windowsHide: true });
      report.backingOracle = existsSync(path.join(oracleDir, "report.json")) ?
        JSON.parse(readFileSync(path.join(oracleDir, "report.json"), "utf8")) : null;
      if (!report.backingOracle) report.reasons.push(`PCM oracle unavailable: ${result.stderr.trim()}`);
      if (report.backingOracle?.status === "FAIL") {
        report.status = "FAIL";
        report.reasons.push("Captured backing-track PCM has a confirmed defect");
      }
    } else report.reasons.push("Native pre-submit PCM capture unavailable for this backend");
    if (!existsSync(path.join(directory, "performance.wav")))
      report.reasons.push("Performance recording missing");
    report.reasons.push("Microphone reference and acoustic loopback unavailable; concurrent voice quality unclassified");
    if (profile.recovery) report.reasons.push("RecoverSession does not simulate a physical DeviceLost event");
    if (profile.name === "buffer-pressure")
      report.reasons.push("CPU pressure does not guarantee a buffer underrun or overrun");
  } catch (error) {
    report.reasons.push(String(error));
  } finally {
    clearInterval(timer);
    for (const load of loads) load.kill();
    try { await audio(pipe, "ShutdownService"); } catch { /* service may have exited */ }
    child.kill();
    report.finishedAt = new Date().toISOString();
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  }
  return report;
};
const results = [];
if (mode !== "room") for (const profile of chosenLocal) results.push(await runLocal(profile));
if (mode !== "local") for (const profile of chosenRoom) {
  const directory = path.join(output, "room", profile.name);
  mkdirSync(directory, { recursive: true });
  const report = { mode: "room", profile, seed, status: "INCONCLUSIVE",
    reasons: [] };
  if (profile.name === "normal") {
    const gate = process.env.AD_VOICE_QUALITY_ROOM_GATE ??
      path.join(root, "frontend", "electron", "multi-electron-room-e2e.mjs");
    const run = spawnSync(process.execPath, [gate], { cwd: path.join(root, "frontend"),
      encoding: "utf8", timeout: 4 * 60_000, windowsHide: true });
    writeFileSync(path.join(directory, "ui-gate.stdout.txt"), run.stdout ?? "");
    writeFileSync(path.join(directory, "ui-gate.stderr.txt"), run.stderr ?? "");
    const last = (run.stdout ?? "").trim().split(/\r?\n/).at(-1);
    try { report.uiGate = JSON.parse(last); } catch { /* the gate may stop before reporting */ }
    if (run.status !== 0 || report.uiGate?.result !== "PASS")
      report.reasons.push(`Two-window UI gate failed: ${run.error?.message ?? run.status}`);
    else report.reasons.push("Two-window UI gate passed; weak-PC room quality matrix and new PCM oracle remain unverified");
  } else report.reasons.push("Room stress profile is planned but not exercised with the required participant-specific load and UI evidence");
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  results.push(report);
}
const summary = { mode, seed, output, status: results.some(r => r.status === "FAIL") ? "FAIL" :
  results.some(r => r.status === "INCONCLUSIVE") ? "INCONCLUSIVE" : "PASS", results };
writeFileSync(path.join(output, "report.json"), JSON.stringify(summary, null, 2));
console.log(path.join(output, "report.json"));
process.exitCode = { PASS: 0, FAIL: 1, INCONCLUSIVE: 3 }[summary.status];
