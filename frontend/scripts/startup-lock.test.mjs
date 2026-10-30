import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { transformSync } from "esbuild";
import { runInNewContext } from "node:vm";
import {
  claimRunningApp,
  releaseRunningApp,
  runningAppPid,
  transferRunningApp,
} from "../../scripts/running-app.mjs";

const buildSteps = readFileSync(
  new URL("../../scripts/build-steps.mjs", import.meta.url),
  "utf8",
);
const launchers = ["start-electron.mjs", "dev-electron.mjs"].map((name) =>
  readFileSync(new URL(name, import.meta.url), "utf8"),
);

// Exercise the real command planner without installing packages, opening audio devices,
// changing the running developer profile, or building into another task's live output.
const runSteps = async (args, options = {}) => {
  const calls = [];
  const logs = [];
  const stamp = createHash("sha256").update("").digest("hex");
  const context = {
    path,
    createHash,
    loadEnvFile: () => {},
    mkdirSync: () => {},
    existsSync: (file) => !options.missingModules || !String(file).endsWith("node_modules"),
    readFileSync: (file) => {
      if (String(file).includes(".ad-voice-")) return stamp;
      return { "CMakeCache.txt": "AUDIOSERVICE_BUILD_TESTS:BOOL=ON" }[path.basename(String(file))] ?? "";
    },
    writeFileSync: () => {},
    lookup: async () => {},
    fileURLToPath: () => process.cwd(),
    runningAppPid: () => options.activePid ?? null,
    console: {
      log: (...values) => logs.push(values.join(" ")),
      error: (...values) => logs.push(values.join(" ")),
    },
    process: {
      argv: ["node", "build-steps.mjs", ...args],
      env: { ...process.env },
      stdout: { write() {} },
      stderr: { write() {} },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { exitCode: code });
      },
    },
    spawn: (command) => {
      calls.push(command);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", options.fail?.test(command) ? 1 : 0));
      return child;
    },
  };
  const executable = buildSteps
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(import.meta.url));
  let exitCode = 0;
  try {
    await runInNewContext(`(async () => {${executable}\n})()`, context);
  } catch (error) {
    if (error.exitCode === undefined) throw error;
    exitCode = error.exitCode;
  }
  return { calls, logs, exitCode };
};

test("dev startup prepares frontend dependencies without bundling the renderer", async () => {
  const run = await runSteps(["dev"], { missingModules: true });
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.includes("npm ci"), "a fresh dev checkout must prepare its frontend");
  assert.ok(!run.calls.some((c) => /vite build|electron:compile/.test(c)), "Vite serves sources and the dev launcher compiles Electron once");
});

test("dev startup refuses preparation while this project's application is active", async () => {
  const run = await runSteps(["dev"], { activePid: 123 });
  assert.notEqual(run.exitCode, 0);
  assert.deepEqual(run.calls, [], "never reinstall or replace binaries in the active app");
});

test("a failed dev preparation exits without waiting for an interactive keypress", async () => {
  if (process.platform !== "win32") return;
  const project = mkdtempSync(join(tmpdir(), "advoice-dev-failure-"));
  mkdirSync(join(project, "scripts"));
  writeFileSync(join(project, "scripts", "build-steps.mjs"), "process.exit(7)");
  writeFileSync(join(project, "start.bat"), readFileSync(new URL("../../start.bat", import.meta.url)));
  let timedOut = false;
  try {
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start.bat dev"], {
      cwd: project,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.stdin.end("\r\n");
    }, 2000);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timeout));
    assert.notEqual(code, 0);
    assert.equal(timedOut, false, "Codex must receive startup failure instead of hanging at pause");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("full frontend checks keep type checking and the complete existing test command", async () => {
  const run = await runSteps(["check", "frontend"]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.includes("npm run typecheck"));
  assert.ok(run.calls.includes("npm test"));
});

test("focused frontend checks select the renderer and Node test runners separately", async () => {
  const run = await runSteps(["check", "frontend", "src/app/example.test.ts", "scripts/example.test.mjs"]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.some((c) => c.includes("vitest") && c.includes(" run ") && c.includes("src/app/example.test.ts")));
  assert.ok(run.calls.some((c) => c.includes("node --test") && c.includes("scripts/example.test.mjs")));
  assert.ok(!run.calls.includes("npm test"));
  assert.match(run.logs.join("\n"), /focused.*not.*full/i);
});

test("full backend checks retain the strict existing quality runner", async () => {
  const run = await runSteps(["check", "backend"]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.some((c) => c.includes("run_checks.py") && c.includes("--require-dev-tools")));
});

test("focused backend checks keep pytest file and node selection", async () => {
  const run = await runSteps(["check", "backend", "tests/test_example.py::test_case"]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.some((c) => c.includes("-m pytest") && c.includes("tests/test_example.py::test_case")));
});

test("full audio checks build the test binary and run the registered CTest suite", async () => {
  const run = await runSteps(["check", "audio"]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.some((c) => c.startsWith("cmake --build ") && !c.includes("--target")), "build every configured target, including enabled release gates");
  assert.ok(run.calls.some((c) => c.startsWith("ctest ") && c.includes("--output-on-failure")));
});

test("focused checks use the installed test runner and reject native option flags", async () => {
  const run = await runSteps(["check", "frontend", "src/app/example.test.ts"]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.calls.every((c) => !c.startsWith("npx ")), "checks must not download a missing runner");
  const invalid = await runSteps(["check", "audio", "--help"]);
  assert.notEqual(invalid.exitCode, 0);
  assert.deepEqual(invalid.calls, []);
});

test("each requested native regression test runs separately after one build", async () => {
  const run = await runSteps(["check", "audio", "firstRegression", "secondRegression"]);
  assert.equal(run.exitCode, 0);
  assert.equal(run.calls.filter((c) => c.startsWith("cmake --build ")).length, 1);
  const native = run.calls.filter((c) => c.includes("audioservice_tests.exe"));
  assert.equal(native.length, 2, "the native binary accepts one name, so do not silently ignore later tests");
  assert.ok(native[0].endsWith(" firstRegression"));
  assert.ok(native[1].endsWith(" secondRegression"));
});

test("all checks include frontend, strict backend and native tests", async () => {
  const run = await runSteps(["check", "all"]);
  assert.equal(run.exitCode, 0);
  for (const command of ["npm test", "run_checks.py", "ctest "])
    assert.ok(run.calls.some((c) => c.includes(command)), command);
});

test("check failures propagate and invalid scopes or paths never run commands", async () => {
  const failed = await runSteps(["check", "frontend"], { fail: /^npm test$/ });
  assert.notEqual(failed.exitCode, 0);
  for (const args of [
    ["check", "unknown"],
    ["check", "all", "tests/test_example.py"],
    ["check", "frontend", "../outside.test.ts"],
    ["check", "backend", "--ignore=tests"],
  ]) {
    const run = await runSteps(args);
    assert.notEqual(run.exitCode, 0);
    assert.deepEqual(run.calls, []);
  }
});

test("browser tests own their server and cannot silently reuse another project's dev server", () => {
  const source = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  const module = { exports: {} };
  runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, {
    module,
    exports: module.exports,
    require: () => ({ defineConfig: (config) => config }),
    process: { env: {} },
  });
  const config = module.exports.default;
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(config.webServer.url, config.use.baseURL);
  assert.match(config.webServer.command, /--strictPort/);
  assert.ok(!config.use.baseURL.endsWith(":5173"), "tests leave the ordinary dev port alone");
});

test("startup detects the running project before npm can replace locked binaries", () => {
  const project = mkdtempSync(join(tmpdir(), "advoice-running-app-"));
  try {
    assert.equal(claimRunningApp(project, process.pid), true);
    assert.equal(runningAppPid(project), process.pid);
    assert.equal(claimRunningApp(project, process.pid + 1), false);
    assert.ok(
      buildSteps.indexOf("runningAppPid(root)") < buildSteps.indexOf('"npm ci"'),
      "the active-app guard must run before npm ci",
    );
    for (const launcher of launchers)
      assert.match(launcher, /claimRunningApp\(projectRoot, process\.pid\)/);
  } finally {
    releaseRunningApp(project, process.pid);
    rmSync(project, { recursive: true, force: true });
  }
});

test("the launcher transfers and releases only its own running marker", () => {
  const project = mkdtempSync(join(tmpdir(), "advoice-running-app-"));
  try {
    assert.equal(claimRunningApp(project, process.pid), true);
    assert.equal(transferRunningApp(project, process.pid + 1, process.pid + 2), false);
    assert.equal(runningAppPid(project), process.pid);
    assert.equal(transferRunningApp(project, process.pid, process.pid), true);
    releaseRunningApp(project, process.pid + 1);
    assert.equal(runningAppPid(project), process.pid);
    releaseRunningApp(project, process.pid);
    assert.equal(runningAppPid(project), null);
  } finally {
    releaseRunningApp(project, process.pid);
    rmSync(project, { recursive: true, force: true });
  }
});

test("multi launcher keeps normal storage and prevents dotenv from restoring it for the guest", () => {
  const source = readFileSync(new URL("launch-multi.mjs", import.meta.url), "utf8")
    .replace(/^import[^\n]+\r?\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(import.meta.url));
  for (const isolated of [false, true]) {
    const calls = [];
    const normalData = "E:/Library";
    runInNewContext(source, {
      URL, join, fileURLToPath: () => "D:/App/frontend", existsSync: () => true,
      loadEnvFile: () => {},
      process: { env: { AD_VOICE_DATA: normalData, AD_VOICE_MULTI_E2E: isolated ? "1" : "0" }, stdout: { write() {} } },
      spawn: (_command, _args, options) => {
        calls.push(options.env);
        return { pid: 123, unref() {} };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].AD_VOICE_DATA, isolated ? "" : normalData);
    assert.equal(calls[1].AD_VOICE_DATA, "");
  }
});
