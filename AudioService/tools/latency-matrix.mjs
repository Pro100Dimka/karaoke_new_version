// Measures the hidden (driver-unreported) round-trip latency across backends, rates and buffers.
// A speaker on the output is held to the microphone; "loop" rows use the interface's digital
// loopback instead, which isolates the USB/driver part from the converters and the speaker.
// Usage: node latency-matrix.mjs <out.json> [--quick]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = path.join(root, "AudioService", "build", "Release", "AudioService.exe");
const [outFile = "latency-matrix.json"] = process.argv.slice(2);
const quick = process.argv.includes("--quick");
const pipe = `ADVoice.LatencyMatrix.${crypto.randomUUID().slice(0, 8)}`;
const child = spawn(executable, [], {
  env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: "\\\\.\\pipe\\" + pipe }, windowsHide: true, stdio: "ignore",
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = line => new Promise((resolve, reject) => {
  const socket = net.createConnection("\\\\.\\pipe\\" + pipe);
  let text = "";
  socket.once("connect", () => socket.write(`${line}\n`));
  socket.on("data", chunk => { text += chunk; });
  socket.once("close", () => resolve(text));
  socket.once("error", reject);
});
const audio = async line => {
  for (let attempt = 0; ; attempt += 1) {
    try { return await once(line); } catch (error) { if (attempt > 60) throw error; await delay(100); }
  }
};
const parse = text => Object.fromEntries(text.replace(/^\d\|/, "").split("\n").map(l => l.split(": ")).filter(p => p.length === 2));

const measure = async () => {
  const values = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await audio("1|MeasureAcousticLatency");
    for (let wait = 0; wait < 60; wait += 1) {
      await delay(100);
      const state = (await audio("1|GetAcousticLatency")).trim();
      if (/state=Done/.test(state)) { values.push(Number(/ms=([0-9.]+)/.exec(state)[1])); break; }
      if (/state=Failed/.test(state)) { values.push(null); break; }
    }
  }
  const ok = values.filter(v => v !== null).sort((a, b) => a - b);
  return { values, medianMs: ok.length ? ok[Math.floor(ok.length / 2)] : null };
};

const rows = [];
try {
  const devices = (await audio("1|GetDevices")).slice(2).split(/\r?\n/).filter(Boolean).map(line => {
    const [id, name, kind, output] = line.split(",");
    return { id, name, kind, output: output === "1" };
  });
  const find = (output, pattern) => devices.find(d => d.output === output && d.kind === "1" && pattern.test(d.name))?.id;
  const speaker = find(true, /^Analogue 1\/2/);
  const mic = find(false, /^Analogue 1\/2/);
  const loop = find(false, /^Loop-back 1\/2/);
  const rates = quick ? [48000] : [44100, 48000];
  const configs = [];
  for (const rate of rates) {
    for (const [input, path_] of [[mic, "acoustic"], [loop, "loop"]]) {
      configs.push({ backend: "wasapi-shared", rate, period: 0, input, output: speaker, path: path_ });
      configs.push({ backend: "wasapi-exclusive", rate, period: 0, input, output: speaker, path: path_ });
    }
    for (const period of quick ? [64] : [32, 64, 128])
      configs.push({ backend: "asio", rate, period, input: "", output: "", path: "acoustic (ASIO in 1)" });
  }
  for (const config of configs) {
    const configured = await audio(`1|Reconfigure|backend=${config.backend}|input=${config.input}|output=${config.output}|rate=${config.rate}|period=${config.period}|inChannels=0|outChannels=0`);
    if (!configured.startsWith("0|")) { rows.push({ ...config, error: configured.trim() }); continue; }
    await audio("1|StartSession");
    await audio("1|SetMonitoring|enabled=false");
    await delay(1500);
    const diag = parse(await audio("1|GetDiagnostics"));
    const result = await measure();
    const rateHz = Number(diag.RuntimeOutputSampleRate) || config.rate;
    const ms = frames => Math.round(Number(frames) / rateHz * 100000) / 100;
    const row = {
      ...config,
      runtimeRate: rateHz,
      inPeriod: Number(diag.RuntimeInputPeriodFrames), outPeriod: Number(diag.RuntimeOutputPeriodFrames),
      reportedInMs: ms(diag.RuntimeInputLatencyFrames), reportedOutMs: ms(diag.RuntimeOutputLatencyFrames),
      estimatedMs: ms(diag.EstimatedLatencyFrames),
      hiddenMs: result.medianMs, hiddenRuns: result.values,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  child.kill();
  writeFileSync(outFile, JSON.stringify(rows, null, 1));
}
