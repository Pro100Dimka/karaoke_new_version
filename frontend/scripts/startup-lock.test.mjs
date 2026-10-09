import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
