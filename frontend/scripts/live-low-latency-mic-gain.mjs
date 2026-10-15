/** Physical effect of "Minimum microphone latency", through AudioService itself (engineering check).
 * Sets the switch in the rendered UI, then runs AudioService's optional acoustic diagnostic (quiet chirps
 * through the speakers, found in the microphone) three times per mode. The microphone-to-output path is
 * the timestamp-observed latency plus the residual the timestamps cannot see.
 * Usage: node scripts/live-low-latency-mic-gain.mjs <port> <outFile>
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [port = "9351", outFile = "low-latency-mic-gain.json"] = process.argv.slice(2);
const control = path.resolve("..", "AudioService", "build", "Release", "AudioControl.exe");
const env = { ...process.env, AD_VOICE_AUDIO_ENDPOINT: String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1` };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (...args) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync(control, args, { env, encoding: "utf8" });
    } catch (error) {
      if (attempt >= 20) throw error;
      execFileSync("powershell", ["-NoProfile", "-c", "Start-Sleep -Milliseconds 250"]);
    }
  }
};
const diagnostics = () => Object.fromEntries(run("GetDiagnostics").split(/\r?\n/)
  .map((line) => line.split(": ")).filter((pair) => pair.length === 2));
const measure = async () => {
  run("MeasureAcousticLatency");
  for (let i = 0; i < 80; i += 1) {
    await delay(100);
    const fields = Object.fromEntries(run("GetAcousticLatency").trim().replace(/^\d+\|/, "")
      .split("|").map((field) => field.split("=")));
    if (fields.state === "Done") return Number(fields.ms);
    if (fields.state === "Failed") return null;
  }
  return null;
};

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
if (!(await page.locator("dialog.settingsDialog[open]").count())) {
  await page.getByRole("button", { name: /Настройки|Settings|Налаштування/i }).first().click();
  await delay(1_500);
}
await page.getByText(/^(Аудио|Audio|Аудіо)$/).first().click();
await delay(2_000);
const theSwitch = page.getByRole("switch").first();
const results = [];
for (const on of [false, true, false, true]) {
  if ((await theSwitch.isChecked()) !== on)
    await theSwitch.locator("xpath=ancestor::label[1]").click();
  await delay(5_000);
  const d = diagnostics();
  const observed = Number(d.LocalObservedMonitoringMs);
  const hidden = [];
  for (let i = 0; i < 3; i += 1) hidden.push(await measure());
  const valid = hidden.filter((value) => value !== null).sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)] : null;
  const row = { switch: on, inputMode: d.InputMode, outputMode: d.OutputMode, observedMs: observed,
    hiddenMs: hidden, micToOutputMs: median === null ? null : observed + median };
  results.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(outFile, JSON.stringify(results, null, 2));
await browser.close().catch(() => undefined);
