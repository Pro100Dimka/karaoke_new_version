import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const executable = fileURLToPath(new URL("../../AudioService/build/Release/AudioControl.exe", import.meta.url));
const run = promisify(execFile);
const options = { skip: process.platform !== "win32" || !existsSync(executable) };

const fixture = async (context, reply) => {
  const endpoint = String.raw`\\.\pipe\ADVoice.ToolTest.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    socket.once("data", data => { assert.match(data.toString(), /^1\|GetDiagnostics\n$/); reply(socket); });
  });
  context.after(async () => {
    for (const client of clients) client.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return () => run(executable, ["audio-dump"], {
    windowsHide: true, timeout: 3000, maxBuffer: 1 << 20,
    env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: endpoint },
  });
};

test("AudioControl uses the configured endpoint and reads a complete large diagnostic reply", options, async context => {
  const reply = "0|" + "Мікрофон 🎤\n".repeat(4096) + "done\n";
  const invoke = await fixture(context, socket => socket.end(reply));
  assert.ok((await invoke()).stdout.replaceAll("\r\n", "\n") === reply, "diagnostics must not be truncated");
});

test("AudioControl propagates a rejected command as a nonzero exit status", options, async context => {
  const invoke = await fixture(context, socket => socket.end("5|Failed\n"));
  await assert.rejects(invoke(), error => error.code === 1 && /Failed/.test(error.stdout));
});

test("AudioControl reports an empty or truncated pipe reply as failure", options, async context => {
  for (const reply of ["", "0|truncated"]) {
    const invoke = await fixture(context, socket => socket.end(reply));
    await assert.rejects(invoke(), error => error.code === 1 && /reply/i.test(error.stderr));
  }
});
