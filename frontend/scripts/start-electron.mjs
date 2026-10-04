import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
try {
  loadEnvFile(new URL("../.env.local", import.meta.url));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const electronExecutable = join(frontendRoot, "node_modules", "electron", "dist", "electron.exe");
if (!existsSync(electronExecutable)) throw new Error(`Electron executable was not found: ${electronExecutable}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(electronExecutable, [frontendRoot, ...process.argv.slice(2)], {
  cwd: frontendRoot,
  env,
  stdio: "inherit",
});

electron.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
