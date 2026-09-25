import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", () => ({ createConnection }));

const sockets: Array<ReturnType<typeof socket>> = [];
const socket = () => Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
let reply: (connection: ReturnType<typeof socket>, request: string) => void;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  sockets.length = 0;
  reply = connection => {
    connection.emit("data", Buffer.from("0|Ok\n"));
    connection.emit("end");
  };
  createConnection.mockReset().mockImplementation(() => {
    const connection = socket();
    connection.write.mockImplementation((request: string) => reply(connection, request));
    sockets.push(connection);
    queueMicrotask(() => connection.emit("connect"));
    return connection;
  });
});
afterEach(() => vi.useRealTimers());

it("decodes a multibyte device name split across pipe reads", async () => {
  reply = connection => {
    const bytes = Buffer.from("0|Мікрофон 🎤\n");
    for (const byte of bytes) connection.emit("data", Buffer.from([byte]));
    connection.emit("end");
  };
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  await expect(sendAudioRequest({ command: "GetDevices" })).resolves.toEqual({ status: 0, text: "Мікрофон 🎤" });
});

it.each([
  { command: "Play|ignored" },
  { command: "Play\n1|Stop" },
  { command: "SetGain", args: { "input|output": 1 } },
  { command: "LoadSong", args: { path: "song|rate=2" } },
  { command: "LoadSong", args: { path: "song\n" } },
  { command: "LoadSong", args: { path: "song\0" } },
  { command: "SetGain", args: { value: NaN } },
  { command: "LoadSong", args: { path: "я".repeat(4096) } },
])("rejects malformed control frames before opening the pipe, case %#", async request => {
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  await expect(sendAudioRequest(request)).rejects.toThrow();
  expect(createConnection).not.toHaveBeenCalled();
});

it.each(["|Ok\n", " |Ok\n", "0|truncated"])("rejects a malformed or incomplete reply, case %#", async response => {
  reply = connection => { connection.emit("data", Buffer.from(response)); connection.emit("end"); };
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  await expect(sendAudioRequest({ command: "GetDiagnostics" })).rejects.toThrow(/Malformed/);
});

it("rejects an oversized response without retaining unlimited bytes", async () => {
  reply = connection => {
    connection.emit("data", Buffer.from("0|" + "x".repeat(1 << 20) + "\n"));
    connection.emit("end");
  };
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  await expect(sendAudioRequest({ command: "GetDiagnostics" })).rejects.toThrow(/too large/);
  expect(sockets[0]?.destroy).toHaveBeenCalled();
});

it("does not execute an expired command after it waits behind another command", async () => {
  reply = () => {};
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  const first = sendAudioRequest({ command: "GetDiagnostics" }, 100);
  const second = sendAudioRequest({ command: "Play" }, 20);
  const firstFailure = expect(first).rejects.toThrow(/timed out/);
  const secondFailure = expect(second).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(200);
  await Promise.all([firstFailure, secondFailure]);
  expect(createConnection).toHaveBeenCalledOnce();
});

it("bounds pending commands when a client floods a stalled pipe", async () => {
  reply = () => {};
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  let rejected = 0;
  const requests = Array.from({ length: 1000 }, () => sendAudioRequest({ command: "GetDiagnostics" }, 100)
    .catch(() => { rejected++; }));
  await vi.advanceTimersByTimeAsync(0);
  expect(rejected).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(101);
  await Promise.all(requests);
});

it("snapshots accepted arguments before they wait in the queue", async () => {
  reply = () => {};
  const { sendAudioRequest } = await import("./AudioServiceTransport");
  const first = sendAudioRequest({ command: "GetDiagnostics" });
  const args = { value: 0.5 };
  const next = sendAudioRequest({ command: "SetGain", args });
  args.value = 10;
  await vi.advanceTimersByTimeAsync(0);
  sockets[0]?.emit("data", Buffer.from("0|Ok\n"));
  sockets[0]?.emit("end");
  reply = connection => { connection.emit("data", Buffer.from("0|Ok\n")); connection.emit("end"); };
  await Promise.all([first, next]);
  expect(sockets[1]?.write).toHaveBeenCalledWith("1|SetGain|value=0.5\n");
});
