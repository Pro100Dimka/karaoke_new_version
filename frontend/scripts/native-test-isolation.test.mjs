import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const executable = fileURLToPath(new URL("../../AudioService/build/Release/audioservice_tests.exe", import.meta.url));
const run = promisify(execFile);
test("native test processes never delete a shared temporary directory", {
  skip: process.platform !== "win32" || !existsSync(executable),
}, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ad-voice-test-isolation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const shared = path.join(root, "audioservice-tests");
  await mkdir(shared);
  const sentinel = path.join(shared, "other-process.txt");
  await writeFile(sentinel, "owned by another process");
  const options = { windowsHide: true, timeout: 5000, env: { ...process.env, TEMP: root, TMP: root } };
  await assert.rejects(run(executable, ["unknown-test-name"], options), error => error.code === 2);
  assert.equal(await readFile(sentinel, "utf8"), "owned by another process");
  await Promise.all(Array.from({ length: 4 }, () => run(executable, ["wavDecoderReportsFormat"], options)));
  assert.equal(await readFile(sentinel, "utf8"), "owned by another process");
});
