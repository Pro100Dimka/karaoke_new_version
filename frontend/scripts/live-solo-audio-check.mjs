/** Live single-instance audio check driven through the rendered UI (CDP), with AudioService diagnostics.
 * Ordinary headphone workflow: no acoustic loop, no chirp, no calibration dialog is expected.
 * Usage (app started with --remote-debugging-port): node scripts/live-solo-audio-check.mjs <port> <outDir>
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [port = "9351", outDir = "live-solo"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const control = path.resolve("..", "AudioService", "build", "Release", "AudioControl.exe");
const env = { ...process.env, AD_VOICE_AUDIO_ENDPOINT: String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1` };
const command = (...args) => execFileSync(control, args, { env, encoding: "utf8" });
const keys = [
  "Backend", "RuntimeOutputSampleRate", "RuntimeInputSampleRate", "RuntimeOutputPeriodFrames",
  "MonitoringEnabled", "MicrophoneEnabled", "InputPeak", "PlaybackState", "RecordingState",
  "MasterOutputNonzeroBlocks", "MasterOutputPeak", "MusicUnderruns", "XRuns",
  "AcousticCalibrationOrigin", "AcousticCalibrationValid", "AcousticLatencyUs", "AcousticPassiveEnabled",
  "AcousticCalibrationRequired", "LocalObservedMonitoringMs", "LocalPhysicalLatencyMs",
  "RenderCallbackP95Us", "CaptureCallbackP95Us", "RenderWorkP95Us", "RenderJitWaitOnlyP95Us",
  "RenderJitDeadlineOvershootP95Us", "RenderJitDeferredCaptures", "RenderJitLateEvents",
];
const diagnostics = (label) => {
  const all = Object.fromEntries(command("GetDiagnostics").split(/\r?\n/)
    .map((line) => line.split(": ")).filter((pair) => pair.length === 2));
  const acoustic = command("GetAcousticLatency").trim();
  return { label, at: new Date().toISOString(), acoustic, ...Object.fromEntries(keys.map((k) => [k, all[k]])) };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];
const failures = [];
const expect = (ok, text) => { (ok ? console.log : console.error)(`${ok ? "PASS" : "FAIL"} ${text}`); if (!ok) failures.push(text); };
const acousticPrompt = /акустическ|приложите|поднесите|тестов(ый|ые|ых) сигнал|acoustic loop|test signal/i;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const reveal = async () => {
  const size = page.viewportSize() ?? { width: 900, height: 800 };
  await page.mouse.move(size.width / 2, size.height - 60);
  await page.mouse.move(size.width / 2 + 5, size.height - 40);
  await delay(400);
};
// Leaving a performance asks to stop and save the recording; the save is the ordinary answer.
const toLibrary = async () => {
  await page.goto(page.url().replace(/#.*$/, "#/"));
  await delay(1_500);
  const save = page.getByRole("dialog").getByRole("button", { name: /Сохран|Save|Зберег|Останов|Stop/i });
  if (await save.count()) await save.first().click();
  await delay(5_000);
};
const noAcousticDialog = async (where) => {
  const dialogs = await page.getByRole("dialog").allInnerTexts().catch(() => []);
  expect(!dialogs.some((text) => acousticPrompt.test(text)), `${where}: no acoustic-loop dialog`);
};

await toLibrary();
await shot("01-library");
await noAcousticDialog("library");
steps.push(diagnostics("library-idle"));

const card = page.locator(".songCard").first();
const title = (await card.innerText()).split("\n")[0];
await card.getByRole("button", { name: /Запустить караоке|Play karaoke|Запустити караоке/i }).click();
await page.waitForURL(/#\/karaoke\//, { timeout: 120_000 });
await delay(6_000);
await shot("02-karaoke-ready");
await noAcousticDialog("karaoke ready");
const monitor = page.getByRole("button", { name: /^(Мониторинг|Monitoring|Моніторинг)$/i });
// Opening a song from the library starts it; the user recording starts with it.
await reveal();
if ((await monitor.getAttribute("aria-pressed")) === "true") await monitor.click();
await delay(8_000);
await shot("03-playing-monitor-off");
await noAcousticDialog("playing");
const off = diagnostics("playing-monitoring-off");
steps.push(off);
expect(off.PlaybackState === "3", `song plays (PlaybackState=${off.PlaybackState})`);
expect(Number(off.MasterOutputPeak) > 0, `song reaches the output (peak ${off.MasterOutputPeak})`);
expect(Number(off.InputPeak) > 0, `microphone is captured (InputPeak ${off.InputPeak})`);
expect(off.MonitoringEnabled === "0", "monitoring is off");
expect(off.RecordingState === "2", `user recording runs with monitoring off (RecordingState=${off.RecordingState})`);
expect(/state=Idle/.test(off.acoustic), `no acoustic measurement runs (${off.acoustic.split("|")[0]})`);

await reveal();
await monitor.click();
await delay(6_000);
await reveal();
await shot("04-playing-monitor-on");
const on = diagnostics("playing-monitoring-on");
steps.push(on);
expect(on.MonitoringEnabled === "1", "monitoring turns on through the UI");
expect(on.RecordingState === off.RecordingState, "recording is unaffected by the monitoring toggle");
await reveal();
await monitor.click();
await delay(3_000);
const offAgain = diagnostics("playing-monitoring-off-again");
steps.push(offAgain);
expect(offAgain.MonitoringEnabled === "0" && offAgain.RecordingState === off.RecordingState,
  "monitoring off again keeps the recording");

await reveal();
await page.getByRole("toolbar").getByRole("button", { name: /^(Пауза|Pause|Призупинити)$/i }).click();
await delay(2_000);
steps.push(diagnostics("paused"));
await shot("05-paused");
await toLibrary();
await shot("06-library-after");
steps.push(diagnostics("library-after"));
await noAcousticDialog("after return");

writeFileSync(path.join(outDir, "diagnostics.json"),
  JSON.stringify({ song: title, failures, steps }, null, 2));
console.log(`song: ${title}; failures: ${failures.length}`);
await browser.close().catch(() => undefined);
process.exit(failures.length ? 1 : 0);
