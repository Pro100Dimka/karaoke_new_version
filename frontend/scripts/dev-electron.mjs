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
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill();
};

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "inherit", shell: true });
let electron;
let stopping = false;
const stopAll = () => {
  if (stopping) return;
  stopping = true;
  killTree(electron);
  killTree(vite);
};
const exitForSignal = code => {
  stopAll();
  process.exit(code);
};
process.once("exit", stopAll);
process.once("SIGINT", () => exitForSignal(130));
process.once("SIGTERM", () => exitForSignal(143));
process.once("SIGHUP", () => exitForSignal(129));

try {
  await waitForServer();
  const compiled = spawnSync("npm run electron:compile", { stdio: "inherit", shell: true });
  if (compiled.status !== 0) throw new Error("electron:compile failed");

  const env = { ...process.env, VITE_DEV_SERVER_URL: url };
  // Electron must start as an application, not as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn("npx", ["electron", ".", ...process.argv.slice(2)], { stdio: "inherit", shell: true, env });
  electron.once("exit", code => {
    electron = undefined;
    killTree(vite);
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error.message);
  stopAll();
  process.exit(1);
}
