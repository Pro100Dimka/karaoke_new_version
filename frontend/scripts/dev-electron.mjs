// Development run: Vite dev server (hot reload of the renderer) + Electron pointed at it.
// Renderer edits apply instantly; edits under electron/ still need this script restarted.
import { spawn, spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(new URL("../.env.local", import.meta.url));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const port = 5173;
const url = `http://127.0.0.1:${port}`;
const startupTimeoutMilliseconds = 60_000;
const pollMilliseconds = 250;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const waitForServer = async () => {
  const deadline = Date.now() + startupTimeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(pollMilliseconds);
  }
  throw new Error(`Vite dev server did not start on ${url}`);
};

const killTree = child => {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill();
};

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "inherit", shell: true });
const stopVite = () => killTree(vite);
process.on("exit", stopVite);
process.on("SIGINT", () => process.exit(130));

try {
  await waitForServer();
  const compiled = spawnSync("npm run electron:compile", { stdio: "inherit", shell: true });
  if (compiled.status !== 0) throw new Error("electron:compile failed");

  const env = { ...process.env, VITE_DEV_SERVER_URL: url };
  // Electron must start as an application, not as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawn("npx", ["electron", ".", ...process.argv.slice(2)], { stdio: "inherit", shell: true, env });
  electron.on("exit", code => {
    stopVite();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error.message);
  stopVite();
  process.exit(1);
}
