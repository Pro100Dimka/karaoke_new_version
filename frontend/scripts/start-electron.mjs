import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
try {
  loadEnvFile(new URL("../.env.local", import.meta.url));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn("npx", ["electron", frontendRoot, ...process.argv.slice(2)], {
  cwd: frontendRoot,
  env,
  shell: true,
  stdio: "inherit",
});

electron.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
