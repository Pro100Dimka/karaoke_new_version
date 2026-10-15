/** Live check of "Minimum microphone latency" through the rendered settings UI (CDP).
 * A probe opens the default microphone the ordinary shared way, as another application would.
 * Usage: node scripts/live-low-latency-mic-check.mjs <port> <outDir> <probe.exe> [endpoint]
 */
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [port = "9351", outDir = "live-llm", probeExe] = process.argv.slice(2);
const endpoint = process.argv[5] ?? String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1`;
mkdirSync(outDir, { recursive: true });
const control = path.resolve("..", "AudioService", "build", "Release", "AudioControl.exe");
const env = { ...process.env, AD_VOICE_AUDIO_ENDPOINT: endpoint };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];
const failures = [];
const expect = (ok, text) => {
  console[ok ? "log" : "error"](`${ok ? "PASS" : "FAIL"} ${text}`);
  if (!ok) failures.push(text);
};
// The app polls the same pipe; a momentarily busy pipe is retried, not reported as a failure.
const diagnostics = () => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return Object.fromEntries(
        execFileSync(control, ["GetDiagnostics"], { env, encoding: "utf8" }).split(/\r?\n/)
          .map((line) => line.split(": ")).filter((pair) => pair.length === 2));
    } catch (error) {
      if (attempt >= 20) throw error;
      execFileSync("powershell", ["-NoProfile", "-c", "Start-Sleep -Milliseconds 250"]);
    }
  }
};
const audioServicePid = () => execFileSync("powershell", ["-NoProfile", "-c",
  "(Get-Process AudioService | Select-Object -First 1).Id"], { encoding: "utf8" }).trim();
const handles = () => Number(execFileSync("powershell", ["-NoProfile", "-c",
  `(Get-Process -Id ${audioServicePid()}).HandleCount`], { encoding: "utf8" }).trim());
const probe = () => {
  try {
    return JSON.parse(execFileSync(probeExe, ["probe", "0.3"], { encoding: "utf8" }).trim());
  } catch (error) {
    return JSON.parse(String(error.stdout).trim());
  }
};
const modes = (label) => {
  const d = diagnostics();
  const row = { label, session: d.SessionState, input: d.InputMode, output: d.OutputMode,
    requested: d.LowLatencyMicrophoneRequested, active: d.LowLatencyMicrophoneActive,
    fallback: d.LowLatencyMicrophoneFallback, inputPeak: d.InputPeak,
    inputBuffer: d.RuntimeInputEndpointBufferFrames, observedMs: d.LocalObservedMonitoringMs };
  steps.push(row);
  return row;
};

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
const shot = (name) =>
  page.screenshot({ path: path.join(outDir, `${name}.png`), timeout: 90_000 }).catch((error) =>
    console.error(`screenshot ${name} failed: ${error.message.split(String.fromCharCode(10))[0]}`));
await page.reload();
await delay(4_000);
// The app restores an open settings dialog after a reload.
if (!(await page.locator("dialog.settingsDialog[open]").count())) {
  await page.getByRole("button", { name: /Настройки|Settings|Налаштування/i }).first().click();
  await delay(1_500);
}
await page.getByText(/^(Аудио|Audio|Аудіо)$/).first().click();
await delay(2_500);
// The first switch of the audio tab; "input monitoring" comes later and is never touched here.
const theSwitch = page.getByRole("switch").first();
// The input sits under its visual track; a person clicks the visible switch with its label.
const clickSwitch = () => theSwitch.locator("xpath=ancestor::label[1]").click();
const setTo = async (on) => {
  if ((await theSwitch.isChecked()) !== on) await clickSwitch();
  await delay(4_000);
};
const body = await page.locator("body").innerText();
expect(!/WASAPI/.test(body), "the settings page shows no WASAPI mode name");
expect(/Windows/.test(body) && /Минимальная задержка микрофона|Minimum microphone latency/.test(body),
  "Windows driver and the minimum microphone latency option are shown");

const onlyBusy = process.env.LIVE_ONLY_BUSY === "1";
let row;
let other;
if (!onlyBusy) {
await setTo(false);
row = modes("A off");
other = probe();
expect(row.input === "Shared" && row.output === "Shared" && row.active === "0",
  "A: OFF runs the microphone and output shared");
expect(other.open === true, `A: another app can open the microphone (${other.hresult})`);
await shot("A-off");

await setTo(true);
row = modes("B on");
other = probe();
expect(row.input === "Exclusive" && row.output === "Shared" && row.active === "1" &&
  row.session === "Running", "B: ON opens only the microphone exclusively, output stays shared");
expect(await theSwitch.isChecked(), "B: the switch shows the active mode");
expect(other.open === false, `B: other apps lose the microphone while it is exclusive (${other.hresult})`);
await shot("B-on");

var handleCounts = [];
for (let cycle = 1; cycle <= 3; cycle += 1) {
  await setTo(false);
  const off = modes(`D cycle ${cycle} off`);
  const freed = probe();
  handleCounts.push(handles());
  expect(off.input === "Shared" && off.output === "Shared" && freed.open === true,
    `D${cycle}: OFF releases the microphone to other apps (${freed.hresult})`);
  await setTo(true);
  const on = modes(`D cycle ${cycle} on`);
  expect(on.input === "Exclusive" && on.output === "Shared", `D${cycle}: ON is exclusive again`);
}
await setTo(false);
handleCounts.push(handles());
expect(Math.max(...handleCounts) - Math.min(...handleCounts) <= 20,
  `D: AudioService handles stay flat over the cycles (${handleCounts.join(", ")})`);

}
await setTo(false);
// C: another application holds the microphone exclusively (a shared holder is simply pre-empted
// by Windows, which is what the option's description warns about).
const holder = spawn(probeExe, [process.env.LIVE_HOLDER ?? "probe-exclusive", "20"],
  { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => holder.stdout.once("data", resolve));
await clickSwitch();
await delay(5_000);
row = modes("C busy");
const d = diagnostics();
row.inputUnavailable = d.InputUnavailableReason;
const notice = await page.getByText(
  /Не удалось включить минимальную задержку микрофона|Микрофон занят другим приложением|Could not turn on minimum microphone latency|Another app is using the microphone/,
).count();
await shot("C-busy-fallback");
expect(row.session === "Running" && row.output === "Shared" && row.active === "0" &&
  row.fallback === "DEVICE_IN_USE" && Number(d.BackendOutputNonzeroBlocks ?? 0) >= 0,
  `C: a busy microphone does not break audio (session ${row.session}, input ${row.input}, ${row.inputUnavailable})`);
expect(!(await theSwitch.isChecked()), "C: the switch shows the real mode, not the wish");
expect(notice > 0, "C: a short notice explains the fallback");
await new Promise((resolve) => holder.once("exit", resolve));
await delay(1_000);
await setTo(true);
row = modes("C released");
expect(row.input === "Exclusive" && row.output === "Shared" && row.active === "1",
  "C: once the other app lets go, switching on works without restarting");

writeFileSync(path.join(outDir, "diagnostics.json"), JSON.stringify({ failures, handleCounts, steps }, null, 2));
console.log(`failures: ${failures.length}`);
await browser.close().catch(() => undefined);
process.exit(failures.length ? 1 : 0);
