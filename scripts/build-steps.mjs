// Runs the independent preparation steps of start.bat, start-multy.bat, installer.bat and
// release.bat at the same time: the Python environment, AudioService and the frontend never wait
// for each other. Output lines carry the lane name; the first failing lane stops the run.
//
// Usage: node scripts/build-steps.mjs <dev|start|multi|install|release|check>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runningAppPid } from "./running-app.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const modes = ["dev", "start", "multi", "install", "release", "check"];
if (!modes.includes(mode)) {
  console.error(`Usage: node scripts/build-steps.mjs <${modes.join("|")}>`);
  process.exit(2);
}

const python = path.join(root, "python", ".venv", "Scripts", "python.exe");
const frontend = path.join(root, "frontend");
const audio = path.join(root, "AudioService");
const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
const running = new Set();

if (mode === "start" || mode === "dev") {
  const activePid = runningAppPid(root);
  if (activePid) {
    if (mode === "dev") {
      console.error(`[app] A&D Voice is already running (PID ${activePid}). Close it before start.bat dev; its files were not changed.`);
      process.exit(1);
    }
    console.log(`[app] A&D Voice is already running (PID ${activePid}); focusing its window.`);
    process.exit(0);
  }
}

/**
 * Runs one command, prefixing its output with the lane name; resolves with its exit code, or with
 * its standard output when `capture` is set.
 */
const exec = (lane, command, { cwd = root, check = true, capture = false } = {}) =>
  new Promise((resolve, reject) => {
    let captured = "";
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
    running.add(child);
    const relay = (stream, target) => {
      let pending = "";
      stream.on("data", (chunk) => {
        if (capture && stream === child.stdout) captured += chunk.toString();
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
      else resolve(capture ? captured : code ?? 1);
    });
  });

const all = (tasks) => Promise.all(tasks.map((task) => task()));

/**
 * Installed dependencies carry a stamp of the files they were installed from, so an unchanged
 * lock file skips pip or npm instead of reinstalling everything. Without a stamp, an explicit
 * installation reinstalls; a start trusts a working environment and stamps it.
 */
const fingerprint = (...files) => {
  const hash = createHash("sha256");
  for (const file of files) hash.update(existsSync(file) ? readFileSync(file) : `missing ${file}`);
  return hash.digest("hex");
};
const stampStatus = (stamp, value) =>
  !existsSync(stamp) ? "missing" : readFileSync(stamp, "utf8") === value ? "current" : "stale";
const needsInstall = (stamp, value) => {
  const status = stampStatus(stamp, value);
  return status === "stale" || (status === "missing" && mode === "install");
};

/**
 * Before a step downloads, checks that its server can be found at all. Without a network the
 * tools only print pages of retries and clone errors; this says plainly what is missing.
 */
const requireOnline = async (lane, host, what) => {
  try {
    await lookup(host);
  } catch {
    throw new Error(
      `[${lane}] No internet connection: ${host} cannot be reached, so ${what} cannot be downloaded. ` +
        "Check Wi-Fi, VPN or proxy and run the script again; everything already installed is kept.",
    );
  }
};

// --- Python environment -------------------------------------------------------------------------
const pythonLane = async () => {
  const run = (args, options) => exec("python", `${quote(python)} ${args}`, options);
  if (!existsSync(python)) {
    await exec("python", `py -3.12 -m venv ${quote(path.dirname(path.dirname(python)))}`);
  }
  const lock = path.join(root, "python", "requirements.lock");
  const packages = fingerprint(lock, path.join(root, "python", "pyproject.toml"));
  const stamp = path.join(path.dirname(path.dirname(python)), ".ad-voice-packages");
  const imports = (await run('-c "import yt_dlp, faster_whisper; import backend"', { check: false })) === 0;
  if (imports && !needsInstall(stamp, packages)) {
    console.log("[python] packages match requirements.lock; nothing to install");
  } else {
    await requireOnline("python", "pypi.org", "the Python packages");
    // An environment created without pip (or with pip removed) is repaired from Python itself.
    if ((await run("-m pip --version", { check: false })) !== 0) await run("-m ensurepip --upgrade");
    if (mode === "install") await run("-m pip install --upgrade pip setuptools wheel");
    // The CUDA build of PyTorch goes in first so the lock file does not pull the CPU one.
    await exec("python", `${quote(path.join(root, "ensure-ai-runtime.bat"))} ${quote(python)}`);
    // A cache written by an elevated run (or locked by an antivirus) cannot be read by this user;
    // the packages are then downloaded again instead of failing the whole installation.
    if ((await run(`-m pip install --requirement ${quote(lock)}`, { check: false })) !== 0)
      await run(`-m pip install --no-cache-dir --requirement ${quote(lock)}`);
    await run(`-m pip install --editable ${quote(path.join(root, "python"))} --no-deps`);
  }
  writeFileSync(stamp, packages);
  if (mode === "release") return;
  // Both checks below load PyTorch or Whisper (seconds). Their results only change with the
  // packages or when the model file disappears, so a start after a successful check skips them.
  const runtimeStamp = path.join(path.dirname(path.dirname(python)), ".ad-voice-ai-runtime");
  if (stampStatus(runtimeStamp, packages) !== "current") {
    await exec("python", `${quote(path.join(root, "ensure-ai-runtime.bat"))} ${quote(python)}`);
    writeFileSync(runtimeStamp, packages);
  }
  const acceleratorStamp = path.join(path.dirname(path.dirname(python)), ".ad-voice-accelerator");
  const prepared = existsSync(acceleratorStamp) ? readFileSync(acceleratorStamp, "utf8") : "";
  if (!prepared || !existsSync(path.join(prepared, "model.bin"))) {
    const output = await run("-m backend.ai_worker prepare-accelerator", { check: false, capture: true })
      .catch(() => "");
    // The worker prints one JSON object: {"acceleratedWhisper": "<model folder>"}.
    const json = String(output).split(/\r?\n/).find((line) => line.trim().startsWith("{"));
    let model = "";
    try {
      model = String(JSON.parse(json ?? "{}").acceleratedWhisper ?? "");
    } catch {
      model = "";
    }
    if (model) writeFileSync(acceleratorStamp, model);
    else console.log("[python] Accelerated Whisper is unavailable; using the compatible fallback.");
  }
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
    check: "-DAUDIOSERVICE_BUILD_TESTS=ON",
    release: "-DAUDIOSERVICE_BUILD_TESTS=OFF -DAUDIOSERVICE_BUILD_RELEASE_GATES=OFF",
  }[mode] ?? "";
  // A configured tree regenerates itself when CMakeLists changes; configuring again costs a second.
  if (!existsSync(path.join(build, "_deps", "opus-src")))
    await requireOnline("audio", "github.com", "the Opus codec sources");
  const cache = path.join(build, "CMakeCache.txt");
  const testsDisabled = mode === "check" && existsSync(cache) &&
    !/^AUDIOSERVICE_BUILD_TESTS:BOOL=ON$/m.test(readFileSync(cache, "utf8"));
  if (mode === "install" || mode === "release" || !existsSync(cache) || testsDisabled)
    await exec("audio", `cmake -S ${quote(audio)} -B ${quote(build)} -A x64 ${options}`);
  // Starting the app needs only the client service; a release also installs the native relay.
  const target = {
    install: "",
    check: targets.length ? "--target audioservice_tests" : "",
    release: "--target AudioService NativeVoiceRelay",
  }[mode] ?? "--target AudioService";
  await exec("audio", `cmake --build ${quote(build)} --config Release ${target} --parallel`);
};

// --- Frontend and Electron ----------------------------------------------------------------------
const frontendLane = async () => {
  const npm = (script) => exec("frontend", `npm run ${script}`, { cwd: frontend });
  const modules = path.join(frontend, "node_modules");
  const lock = fingerprint(path.join(frontend, "package-lock.json"));
  const stamp = path.join(modules, ".ad-voice-lock");
  if (!existsSync(modules) || needsInstall(stamp, lock)) {
    await requireOnline("frontend", "registry.npmjs.org", "the frontend packages");
    await exec("frontend", "npm ci", { cwd: frontend });
  }
  else console.log("[frontend] node_modules match package-lock.json; nothing to install");
  writeFileSync(stamp, lock);
  if (mode === "dev") {
    // Vite serves the renderer; dev-electron.mjs compiles the shell once before opening it.
    if (!existsSync(path.join(modules, "electron", "dist", "electron.exe")))
      await npm("electron:install");
    return;
  }
  if (mode !== "start") await npm("electron:install");
  // Type checking emits nothing, so it runs beside the bundler instead of before it.
  await all([
    () => exec("frontend", "npx tsc -b tsconfig.app.json", { cwd: frontend }),
    () => exec("frontend", "npx vite build", { cwd: frontend }),
    () => npm("electron:compile"),
  ]);
};

const scope = process.argv[3] ?? "all";
const targets = process.argv.slice(4).map((value) => value.replaceAll("\\", "/"));
const targetRules = {
  frontend: { directory: frontend, pattern: /^(?:src|electron|scripts)\/[\w./-]+\.test\.(?:tsx?|mjs)$/ },
  backend: { directory: path.join(root, "python"), pattern: /^tests\/[\w./-]+\.py(?:::[\w.-]+)*$/ },
  audio: { pattern: /^[A-Za-z_][\w.-]*$/ },
};
if (mode === "check") {
  const rule = targetRules[scope];
  const invalidTarget = targets.some((target) => {
    if (!rule?.pattern.test(target)) return true;
    if (!rule.directory) return false;
    const file = path.resolve(rule.directory, target.split("::")[0]);
    return path.relative(rule.directory, file).startsWith("..") || !existsSync(file);
  });
  if ((scope !== "all" && !rule) || (scope === "all" && targets.length) || invalidTarget) {
    console.error("Usage: check.bat [frontend|backend|audio|all] [test files or native test names]. Targets must stay inside the selected project area.");
    process.exit(2);
  }
  console.log(targets.length
    ? "[check] Focused checks only, not a full verification. Run the full affected suite before completion."
    : `[check] Full ${scope} checks; existing test suites are preserved.`);
}
const checks = {
  frontend: async () => {
    const run = (command) => exec("frontend", command, { cwd: frontend });
    if (!targets.length) return all([() => run("npm run typecheck"), () => run("npm test")]);
    const runners = {
      "node node_modules/vitest/vitest.mjs run": targets.filter((target) => !target.endsWith(".mjs")),
      "node --test": targets.filter((target) => target.endsWith(".mjs")),
    };
    await all(Object.entries(runners)
      .filter(([, files]) => files.length)
      .map(([command, files]) => () => run(`${command} ${files.map(quote).join(" ")}`)));
  },
  backend: () => exec("backend", targets.length
    ? `${quote(python)} -m pytest -q ${targets.map(quote).join(" ")}`
    : `${quote(python)} scripts/run_checks.py --require-dev-tools`,
  { cwd: path.join(root, "python") }),
  audio: async () => {
    await audioLane();
    const commands = targets.length
      ? targets.map((target) => `${quote(path.join(audio, "build", "Release", "audioservice_tests.exe"))} ${target}`)
      : [`ctest --test-dir ${quote(path.join(audio, "build"))} -C Release --output-on-failure`];
    for (const command of commands) await exec("audio", command);
  },
};
const lanes = {
  dev: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  start: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  multi: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  install: { python: pythonLane, audio: audioLane, frontend: frontendLane },
  release: { audio: audioLane, frontend: frontendLane },
  check: scope === "all" ? checks : { [scope]: checks[scope] },
}[mode];

const started = Date.now();
const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);
try {
  const tasks = Object.entries(lanes).map(([name, lane]) => async () => {
    const laneStarted = Date.now();
    await lane();
    console.log(`[${name}] done in ${seconds(laneStarted)} s`);
  });
  // Keep native/audio tests free of load from the Python and frontend suites.
  if (mode === "check") for (const task of tasks) await task();
  else await all(tasks);
  console.log(`[build] all steps done in ${seconds(started)} s`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // The other lanes would only finish work nobody will use.
  for (const child of running) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  process.exit(1);
}
