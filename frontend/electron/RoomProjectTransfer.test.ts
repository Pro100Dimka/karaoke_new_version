import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { registerRoomProjectTransferHandlers, uploadRoomProject } from "./RoomProjectTransfer";
import { ipcChannels } from "./ipcChannels";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream = vi.fn(actual.createReadStream);
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "room-transfer-test-"));
  roots.push(root);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const sender = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false });
  registerRoomProjectTransferHandlers("https://example.org", () => root, {
    handle: (channel, listener) => { handlers.set(channel, listener); },
  });
  const call = async (channel: string, value: unknown) => handlers.get(channel)?.({ sender } as unknown as IpcMainInvokeEvent, value);
  const project = { roomId: "room", participantId: "guest", songId: "song", revision: 1, transferId: "first" };
  return { call, project, sender };
};

it("keeps completed archives independent until their import releases them", async () => {
  const { call, project } = await setup();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("first archive"))
    .mockResolvedValueOnce(new Response("second archive")));
  const first = await call(ipcChannels.downloadRoomProject, project) as string;
  const second = await call(ipcChannels.downloadRoomProject, { ...project, transferId: "second" }) as string;
  expect(await readFile(first, "utf8")).toBe("first archive");
  expect(first).not.toBe(second);
  // The release operation accepts only a file actually issued by this owner.
  await call("services:release-room-project-download", first);
  await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(second, "utf8")).toBe("second archive");
  await expect(call("services:release-room-project-download", join(tmpdir(), "unowned.zip"))).rejects.toThrow();
});

it("rejects an active duplicate identity without losing the original cancellation handle", async () => {
  const { call, project } = await setup();
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = options.signal ?? undefined;
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const first = call(ipcChannels.downloadRoomProject, project).catch(error => error);
  const duplicate = call(ipcChannels.downloadRoomProject, project).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await duplicate).toBeInstanceOf(Error);
  await call(ipcChannels.cancelRoomProjectTransfer, project.transferId);
  expect(signal?.aborted).toBe(true);
  expect(await first).toBeInstanceOf(Error);
});

it("removes unconsumed downloads when their renderer is destroyed", async () => {
  const { call, project, sender } = await setup();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("archive")));
  const file = await call(ipcChannels.downloadRoomProject, project) as string;
  sender.emit("destroyed");
  await vi.waitFor(async () => { await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" }); });
});

it("cancels failed HTTP response bodies", async () => {
  const { call, project } = await setup();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 404 })));
  await expect(call(ipcChannels.downloadRoomProject, project)).rejects.toThrow("404");
  expect(cancel).toHaveBeenCalledOnce();
});

it("bounds byte progress IPC frequency while still reporting exact completion", async () => {
  const { call, project, sender } = await setup();
  vi.spyOn(performance, "now").mockReturnValue(0);
  let remaining = 1000;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
    pull(controller) { if (remaining-- > 0) controller.enqueue(new Uint8Array(1)); else controller.close(); },
  }), { headers: { "content-length": "1000" } })));
  await call(ipcChannels.downloadRoomProject, project);
  expect(sender.send.mock.calls.length).toBeLessThanOrEqual(2);
  expect(sender.send.mock.lastCall?.[1]).toMatchObject({ transferredBytes: 1000, totalBytes: 1000 });
});

it("closes the upload file stream if the server rejects before reading it", async () => {
  await setup();
  const file = join(roots.at(-1)!, "upload.zip");
  await writeFile(file, "archive");
  const source = new Readable({ read() {} });
  vi.mocked(fs.createReadStream).mockReturnValueOnce(source as fs.ReadStream);
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 413 })));
  await expect(uploadRoomProject("https://example.org", "room", "guest", "song", 1, file)).rejects.toThrow("413");
  expect(fs.createReadStream).toHaveBeenCalledWith(file);
  expect(source.destroyed).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});

it("streams a complete archive to a real HTTP server without leaving the file open", async () => {
  await setup();
  const file = join(roots.at(-1)!, "upload.zip");
  const content = Buffer.alloc(256 * 1024, 73);
  await writeFile(file, content);
  const received: Buffer[] = [];
  const server = createServer(async (request, response) => {
    for await (const chunk of request) received.push(chunk as Buffer);
    response.writeHead(201).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await uploadRoomProject(`http://127.0.0.1:${address.port}`, "room", "guest", "song", 1, file);
    expect(Buffer.concat(received)).toEqual(content);
    await rm(file);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each(["../../escape", "a/b", "a\\b", "..", ".", "CON", "NUL.txt", "song:stream", "song."])(
  "rejects unsafe project identity before downloading: %s", async songId => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    registerRoomProjectTransferHandlers("https://example.org", () => "D:/data", {
      handle: (channel, listener) => { handlers.set(channel, listener); },
    });
    await expect(async () => handlers.get(ipcChannels.downloadRoomProject)?.({} as IpcMainInvokeEvent, {
      roomId: "room", participantId: "guest", songId, revision: 1,
    })).rejects.toThrow("Invalid project identity");
    expect(fetch).not.toHaveBeenCalled();
  },
);
