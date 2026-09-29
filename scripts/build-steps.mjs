// Runs the independent preparation steps of start.bat, start-multy.bat, installer.bat and
// release.bat at the same time: the Python environment, AudioService and the frontend never wait
// for each other. Output lines carry the lane name; the first failing lane stops the run.
//
// Usage: node scripts/build-steps.mjs <dev|start|multi|install|release>
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const modes = ["dev", "start", "multi", "install", "release"];
if (!modes.includes(mode)) {
  console.error(`Usage: node scripts/build-steps.mjs <${modes.join("|")}>`);
  process.exit(2);
}

const python = path.join(root, "python", ".venv", "Scripts", "python.exe");
const frontend = path.join(root, "frontend");
const audio = path.join(root, "AudioService");
const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
const running = new Set();

/** Runs one command, prefixing its output with the lane name; resolves with its exit code. */
const exec = (lane, command, { cwd = root, check = true } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
    running.add(child);
    const relay = (stream, target) => {
      let pending = "";
      stream.on("data", (chunk) => {
        const lines = (pending + chunk.toString()).split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) target.write(`[${lane}] ${line}\n`);
      });
      stream.on("end", () => pending.trim() && target.write(`[${lane}] ${pending}\n`));
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on("error", reject);
    child.on("close", (code) => {
      running.delete(child);
      if (check && code !== 0) reject(new Error(`[${lane}] failed (${code}): ${command}`));
      else resolve(code ?? 1);
    });
  });

const all = (tasks) => Promise.all(tasks.map((task) => task()));

// --- Python environment -------------------------------------------------------------------------
const pythonLane = async () => {
  const run = (args, options) => exec("python", `${quote(python)} ${args}`, options);
  if (!existsSync(python)) {
    await exec("python", `py -3.12 -m venv ${quote(path.dirname(path.dirname(python)))}`);
  }
  if (mode === "install") {
    await run("-m pip install --upgrade pip setuptools wheel");
    await exec("python", `${quote(path.join(root, "ensure-ai-runtime.bat"))} ${quote(python)}`);
    await run(`-m pip install --requirement ${quote(path.join(root, "python", "requirements.lock"))}`);
    await run(`-m pip install --editable ${quote(path.join(root, "python"))} --no-deps`);
  } else if ((await run('-c "import yt_dlp, faster_whisper; import backend"', { check: false })) !== 0) {
    console.log("[python] repairing missing runtime dependencies...");
    await run(`-m pip install --requirement ${quote(path.join(root, "python", "requirements.lock"))}`);
    await run(`-m pip install --editable ${quote(path.join(root, "python"))} --no-deps`);
  }
  if (mode === "release") return;
  if (mode !== "install") await exec("python", `${quote(path.join(root, "ensure-ai-runtime.bat"))} ${quote(python)}`);
  if ((await run("-m backend.ai_worker prepare-accelerator", { check: false })) !== 0)
    console.log("[python] Accelerated Whisper is unavailable; using the compatible fallback.");
  if (mode === "install")
    await run(
      '-c "import yt_dlp; import fastapi, sqlalchemy, uvicorn, torch, demucs, whisper, faster_whisper, ' +
        'torchcrepe, gradio_client; import backend; from backend.infrastructure.youtube_clip import YoutubeClipDownloader"',
    );
};

// --- AudioService -------------------------------------------------------------------------------
const audioLane = async () => {
  const build = mode === "release" ? path.join(audio, "build-release") : path.join(audio, "build");
  const options = {
    install: "-DAUDIOSERVICE_BUILD_TESTS=ON",
    release: "-DAUDIOSERVICE_BUILD_TESTS=OFF -DAUDIOSERVICE_BUILD_RELEASE_GATES=OFF",
  }[mode] ?? "";
  // A configured tree regenerates itself when CMakeLists changes; configuring again costs a second.
  if (mode === "install" || mode === "release" || !existsSync(path.join(build, "CMakeCache.txt")))
    await exec("audio", `cmake -S ${quote(audio)} -B ${quote(build)} -A x64 ${options}`);
  // Starting the app needs only the service, not the tests and tools built with it.
  const target = mode === "install" ? "" : "--target AudioService";
  await exec("audio", `cmake --build ${quote(build)} --config Release ${target} --parallel`);
};

// --- Frontend and Electron ----------------------------------------------------------------------
const frontendLane = async () => {
  const npm = (script) => exec("frontend", `npm run ${script}`, { cwd: frontend });
  if (mode === "install") await exec("frontend", "npm ci", { cwd: frontend });
  else if (!existsSync(path.join(frontend, "node_modules")))
    await exec("frontend", "npm install", { cwd: frontend });
  if (mode !== "start") await npm("electron:install");
  // Type checking emits nothing, so it runs beside the bundler instead of before it.
  await all([
    () => exec("frontend", "npx tsc -b tsconfig.app.json", { cwd: frontend }),
    () => exec("frontend", "npx vite build", { cwd: frontend }),
    () => npm("electron:compile"),
  ]);
};

const lanes = {
  dev: { python: pythonLane, audio: audioLane },
  start: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  multi: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  install: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  release: { audio: audioLane, frontend: frontendLane },
}[mode];

const started = Date.now();
const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);
try {
  await Promise.all(
    Object.entries(lanes).map(async ([name, lane]) => {
      const laneStarted = Date.now();
      await lane();
      console.log(`[${name}] done in ${seconds(laneStarted)} s`);
    }),
  );
  console.log(`[build] all steps done in ${seconds(started)} s`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // The other lanes would only finish work nobody will use.
  for (const child of running) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  process.exit(1);
}
