import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  claimRunningApp,
  releaseRunningApp,
  transferRunningApp,
} from "../../scripts/running-app.mjs";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
try {
  loadEnvFile(new URL("../.env.local", import.meta.url));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const ownsMarker = claimRunningApp(projectRoot, process.pid);
// The app is named as "." from its own folder: through the shell an absolute path would be split at its
// spaces (e.g. a project kept in "Нова папка" reached Electron as "...\Desktop\Нова").
const electron = spawn("npx", ["electron", ".", ...process.argv.slice(2)], {
  cwd: frontendRoot,
  env,
  shell: true,
  stdio: "inherit",
});
if (ownsMarker && electron.pid)
  transferRunningApp(projectRoot, process.pid, electron.pid);

electron.once("exit", (code, signal) => {
  if (ownsMarker) releaseRunningApp(projectRoot, electron.pid ?? process.pid);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
electron.once("error", () => {
  if (ownsMarker) releaseRunningApp(projectRoot, electron.pid ?? process.pid);
});
