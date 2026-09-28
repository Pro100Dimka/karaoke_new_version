// Finds which output device a microphone hears: plays a reference tone on every output and reads the
// input level of every capture endpoint. Used to set up acoustic room-sync probes.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = path.join(root, "AudioService", "build", "Release", "AudioService.exe");
const pipe = `ADVoice.LoopFinder.${crypto.randomUUID().slice(0, 8)}`;
const child = spawn(executable, [], { env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: "\\\\.\\pipe\\" + pipe }, windowsHide: true, stdio: "ignore" });
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
const level = text => Number(/InputRMS: ([0-9.e-]+)/.exec(text)?.[1] ?? 0);
try {
  const devices = (await audio("1|GetDevices")).slice(2).split(/\r?\n/).filter(Boolean).map(line => {
    const [id, name, , output] = line.split(",");
    return { id, name, output: output === "1" };
  });
  const inputs = devices.filter(device => !device.output && /Analogue 1\/2/.test(device.name));
  const outputs = devices.filter(device => device.output && /Audient|Наушники|Динамики|Speakers|Headphone|S24C36x|NVIDIA/.test(device.name));
  const results = [];
  for (const output of outputs) {
    for (const input of inputs) {
      const configured = await audio(`1|Reconfigure|backend=wasapi-shared|input=${input.id}|output=${output.id}|rate=0|period=0|inChannels=0|outChannels=0`);
      if (!configured.startsWith("0|")) continue;
      await audio("1|StartSession");
      await delay(400);
      const quiet = level(await audio("1|GetDiagnostics"));
      await audio("1|PlayReferenceTone|frequency=440|gain=0.2|frames=57600");
      await delay(700);
      const loud = level(await audio("1|GetDiagnostics"));
      results.push({ output: output.name, input: input.name, quiet, loud, ratio: quiet > 0 ? loud / quiet : loud });
    }
  }
  results.sort((a, b) => b.ratio - a.ratio);
  console.log(JSON.stringify(results.slice(0, 8), null, 1));
} finally {
  child.kill();
}
