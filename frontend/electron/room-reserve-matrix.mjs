import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "network-room-server-vocal-process-test.mjs");
const reserves = [5, 7.5, 10, 12.5, 15, 17.5, 20];
const run = reserve => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, "normal", "--seed=0"], { env: { ...process.env, ROOM_RETURN_RESERVE_MS: String(reserve) }, windowsHide: true });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject); child.once("exit", code => { if (code !== 0) return reject(new Error(`${reserve} ms failed: ${stderr}`)); try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); } catch (error) { reject(error); } });
});
const reports = [];
for (const reserve of reserves) {
  reports.push(await run(reserve));
  await new Promise(resolve => setTimeout(resolve, 750));
}
const summary = reports.map(item => ({ reserveMs: item.reserveMs, result: item.result, vocalSkewMs: item.audioAlignment.remoteVocalSkewMs, routeP95Ms: item.routes.totalP95Ms, marginMs: item.routes.deadlineMarginMs, lateCuts: item.processReports.reduce((sum, report) => sum + report.lateAudioCuts, 0), nonzeroMixPackets: item.relayMetrics.nonzero_recipient_packets, artifactRoot: item.artifactRoot }));
const output = path.resolve(path.dirname(script), "../../artifacts/room-e2e/room-reserve-matrix.json");
await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary));
