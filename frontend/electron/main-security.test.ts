import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, raw?: unknown) => unknown>(),
  ready: { run: () => {} },
  sendAudioRequest: vi.fn().mockResolvedValue({ status: 0, text: "Running" }),
  appEvents: new Map<string, (event: { preventDefault(): void }) => void>(),
  stopService: vi.fn(), quit: vi.fn(),
  pythonObserver: {} as { started?(): void; stdout?(data: Buffer): void; stopped?(): void },
}));

const contents = Object.assign(new EventEmitter(), {
  mainFrame: { url: "" },
  send: vi.fn(),
  isDestroyed: () => false,
  setWindowOpenHandler: vi.fn(),
});
const window = Object.assign(new EventEmitter(), {
  webContents: contents,
  isDestroyed: () => false,
  close: vi.fn(),
  loadURL: vi.fn(async (url: string) => { contents.mainFrame.url = url; }),
  loadFile: vi.fn(async () => { contents.mainFrame.url = "file:///D:/Git/karaoke_new_version/frontend/dist/index.html"; }),
});

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "D:/profile", requestSingleInstanceLock: () => true,
    quit: mocks.quit,
    on: (name: string, callback: (event: { preventDefault(): void }) => void) => mocks.appEvents.set(name, callback),
    whenReady: () => ({ then: (callback: () => void) => { mocks.ready.run = callback; } }) },
  BrowserWindow: vi.fn(function () { return window; }),
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, raw?: unknown) => unknown) => mocks.handlers.set(channel, handler) },
  clipboard: {}, dialog: {}, shell: {},
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, existsSync: () => false, default: { ...fs, existsSync: () => false } };
});
vi.mock("./RuntimeIdentity", () => ({ configureRuntimeIdentity: vi.fn() }));
vi.mock("./ServiceProcess", () => ({ ServiceProcess: class {
  constructor(_command: string, _args: string[], _cwd: string, _env: unknown, observer?: typeof mocks.pythonObserver) {
    mocks.pythonObserver = observer ?? {};
  }
  start() { mocks.pythonObserver.started?.(); }
  endInput() {}
  stop(shutdown?: () => Promise<unknown>) { return mocks.stopService(shutdown); }
} }));
vi.mock("./KeyboardLighting", () => ({ createKeyboardLightingProvider: () => null }));
vi.mock("./Splash", () => ({ closeSplash: vi.fn(), openSplash: vi.fn(), readSavedTheme: () => "dark", isThemeName: () => false }));
vi.mock("./SceneProtocol", () => ({ registerSceneProtocol: vi.fn() }));
vi.mock("./WindowState", () => ({ loadWindowState: () => ({ width: 1280, height: 720 }), minWindowHeight: 700, minWindowWidth: 1040 }));
vi.mock("./AudioServiceTransport", () => ({ sendAudioRequest: mocks.sendAudioRequest }));

beforeAll(async () => {
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "D:/app/resources" });
  vi.stubEnv("AD_VOICE_AUDIO_SERVICE", "unused.exe");
  await import("./main");
  mocks.ready.run();
});
afterAll(() => { Reflect.deleteProperty(process, "resourcesPath"); vi.unstubAllEnvs(); });
beforeEach(() => {
  contents.mainFrame.url = "file:///D:/Git/karaoke_new_version/frontend/dist/index.html";
  mocks.sendAudioRequest.mockClear();
});

const audio = async (sender: unknown, frame: unknown) => {
  const { ipcChannels } = await import("./ipcChannels");
  return mocks.handlers.get(ipcChannels.audioRequest)?.({ sender, senderFrame: frame } as IpcMainInvokeEvent, { command: "GetServiceState" });
};

it("rejects a different window even when its frame URL matches", async () => {
  await expect(audio({ mainFrame: contents.mainFrame }, contents.mainFrame)).rejects.toThrow("Untrusted IPC sender");
  expect(mocks.sendAudioRequest).not.toHaveBeenCalled();
});
it("rejects subframes and detached frames", async () => {
  for (const frame of [{ url: contents.mainFrame.url }, null]) {
    await expect(audio(contents, frame)).rejects.toThrow("Untrusted IPC sender");
  }
});
it("rejects remote and sibling local documents in the main window", async () => {
  for (const url of ["https://example.org", "file:///D:/Git/karaoke_new_version/frontend/dist/other.html", "about:blank"]) {
    contents.mainFrame.url = url;
    await expect(audio(contents, contents.mainFrame)).rejects.toThrow("Untrusted IPC sender");
  }
});
it("allows the application main frame including hash routes", async () => {
  contents.mainFrame.url += "#/karaoke/song";
  await expect(audio(contents, contents.mainFrame)).resolves.toEqual({ status: 0, text: "Running" });
});
it("blocks navigation away from the application and denies popup windows", () => {
  const event = { preventDefault: vi.fn(), url: "https://example.org" };
  contents.emit("will-navigate", event, event.url);
  expect(event.preventDefault).toHaveBeenCalled();
  const open = contents.setWindowOpenHandler.mock.calls.at(-1)?.[0] as (() => { action: string }) | undefined;
  expect(open?.()).toEqual({ action: "deny" });
});
it("applies sender validation to room project transfer IPC too", async () => {
  const { ipcChannels } = await import("./ipcChannels");
  for (const channel of [ipcChannels.uploadRoomProject, ipcChannels.downloadRoomProject, ipcChannels.cancelRoomProjectTransfer, ipcChannels.releaseRoomProjectDownload]) {
    await expect(async () => mocks.handlers.get(channel)?.({ sender: contents, senderFrame: null } as IpcMainInvokeEvent, {}))
      .rejects.toThrow("Untrusted IPC sender");
  }
});
it.each([".", "..", "CON"])("rejects unsafe local project identity %s", async songId => {
  const { ipcChannels } = await import("./ipcChannels");
  await expect(async () => mocks.handlers.get(ipcChannels.resolveProjectArtifacts)?.({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent,
    { songId, revision: 1 })).rejects.toThrow("Invalid project identity");
});

it("inspects the actual WAV data chunk and available frames through the desktop IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspect-wave-test-"));
  try {
    const file = join(root, "metadata.wav");
    const buffer = Buffer.alloc(44 + 8192 + 8 + 8);
    buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
    buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write("JUNK", 36); buffer.writeUInt32LE(8192, 40);
    buffer.write("data", 44 + 8192); buffer.writeUInt32LE(32, 48 + 8192);
    await writeFile(file, buffer);
    const { ipcChannels } = await import("./ipcChannels");
    const result = await mocks.handlers.get(ipcChannels.inspectWave)?.({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent, file);
    expect(result).toEqual({ sampleRate: 8000, channels: 1, durationSeconds: 4 / 8000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses only the announced backend endpoint and discards it across restart", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal("fetch", fetch);
  const { ipcChannels } = await import("./ipcChannels");
  const request = () => mocks.handlers.get(ipcChannels.pythonRequest)?.(
    { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent, { method: "GET", path: "/health/ready" });
  try {
    expect(await request()).toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    mocks.pythonObserver.stdout?.(Buffer.from("log line\nAD_VOICE_BACKEND_RE"));
    mocks.pythonObserver.stdout?.(Buffer.from("ADY:51234\n"));
    expect(await request()).toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:51234/health/ready", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const signal = fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    mocks.pythonObserver.stopped?.();
    expect(signal.aborted).toBe(true);
    expect(await request()).toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it("keeps services alive while the renderer is confirming window close", () => {
  const event = { preventDefault: vi.fn() };
  mocks.appEvents.get("before-quit")?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(window.close).toHaveBeenCalledOnce();
  expect(mocks.stopService).not.toHaveBeenCalled();
});

it("defers Electron quit until owned service shutdown finishes", async () => {
  window.emit("closed");
  let finish!: () => void;
  mocks.stopService.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const event = { preventDefault: vi.fn() };
  mocks.appEvents.get("before-quit")?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(typeof mocks.stopService.mock.calls[0]?.[0]).toBe("function");
  expect(mocks.quit).not.toHaveBeenCalled();
  // No AudioService executable was launched by this instance in this fixture.
  expect(mocks.sendAudioRequest).not.toHaveBeenCalledWith(expect.objectContaining({ command: "ShutdownService" }));
  finish();
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
});
