import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  trays: [] as { menu: unknown; destroyed: boolean; tooltip: string }[],
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "1.0.0", getPath: () => "D:/tmp" },
  nativeImage: { createFromBitmap: (buffer: Buffer) => ({ buffer }) },
  Menu: { buildFromTemplate: (template: unknown) => template },
  Tray: class {
    state = { menu: undefined as unknown, destroyed: false, tooltip: "" };
    constructor() {
      electron.trays.push(this.state);
    }
    on() {}
    setToolTip(text: string) {
      this.state.tooltip = text;
    }
    setContextMenu(menu: unknown) {
      this.state.menu = menu;
    }
    destroy() {
      this.state.destroyed = true;
    }
  },
  globalShortcut: { register: () => true, unregister: vi.fn() },
  powerMonitor: { isOnBatteryPower: () => false, on: vi.fn() },
}));

import { installerFromRelease, isNewerVersion } from "./AutoUpdate";
import { DesktopShell, idleShellStatus, type ShellStatus } from "./DesktopShell";
import { activityFor, decodeFrames, encodeFrame } from "./DiscordPresence";
import { jumpListTasks } from "./DesktopLaunch";
import { drawIcon, iconShapes } from "./ShellIcons";
import { shellLanguages, shellTextKeys, shellTextTable } from "./ShellText";
import { JobProgress, overlayFor, thumbButtons } from "./TaskbarIntegration";
import { createTrayRadio, trayMenuTemplate } from "./TrayRadio";

const status = (patch: Partial<ShellStatus>): ShellStatus => ({ ...idleShellStatus, ...patch });
const job = (jobId: string, state: string, overallProgress = 0, jobType = "SongProcessing") => ({
  type: "job.changed",
  data: { jobId, state, overallProgress, type: jobType },
});

describe("taskbar", () => {
  it("averages active processing jobs and reports the ones that finish", () => {
    const jobs = new JobProgress();
    expect(jobs.bar()).toEqual({ progress: -1, mode: "none" });
    jobs.track(job("a", "Queued"));
    expect(jobs.bar().mode).toBe("indeterminate");
    jobs.track(job("a", "Running", 0.4));
    jobs.track(job("b", "Running", 0.8));
    expect(jobs.bar().progress).toBeCloseTo(0.6);
    expect(jobs.track(job("a", "Succeeded", 1))).toBe("succeeded");
    expect(jobs.track(job("b", "Failed"))).toBe("failed");
    expect(jobs.bar().mode).toBe("none");
    // A job finishing that was never followed (e.g. before the app started) raises nothing.
    expect(jobs.track(job("c", "Succeeded"))).toBeUndefined();
    jobs.track(job("d", "Running", 0.5));
    jobs.track({ type: "connected" });
    expect(jobs.bar().mode).toBe("none");
    // A take's analysis after singing shows progress but is not announced as a processed song.
    jobs.track(job("e", "Running", 0.5, "RecordingAnalysis"));
    expect(jobs.bar().mode).toBe("normal");
    expect(jobs.track(job("e", "Succeeded", 1, "RecordingAnalysis"))).toBeUndefined();
  });

  it("offers play/pause in Karaoke and the radio in the Library", () => {
    expect(thumbButtons(status({ screen: "karaoke", song: { title: "Люди" }, playing: true })).map((b) => b.icon)).toEqual(["pause"]);
    expect(thumbButtons(status({ screen: "karaoke", song: { title: "Люди" } })).map((b) => b.command.type)).toEqual(["togglePlayback"]);
    expect(
      thumbButtons(status({ screen: "library", radio: { available: true, enabled: true } })).map((b) => [b.tooltip, b.command.type]),
    ).toEqual([
      ["radioOff", "toggleRadio"],
      ["nextStation", "nextStation"],
    ]);
    expect(thumbButtons(status({ screen: "library", radio: { available: false, enabled: false } }))).toEqual([]);
  });

  it("badges the taskbar icon while recording, otherwise while in a room", () => {
    expect(overlayFor(status({}))).toBeNull();
    expect(overlayFor(status({ room: { code: "AB", participants: 2 } }))?.text).toBe("inRoom");
    expect(overlayFor(status({ recording: true, room: { code: "AB", participants: 2 } }))?.text).toBe("recording");
  });
});

describe("tray", () => {
  it("lists open, radio with its station, next station and quit", () => {
    const send = vi.fn();
    const menu = trayMenuTemplate(status({ radio: { available: true, enabled: true, station: "Lofi" } }), { open: vi.fn(), quit: vi.fn(), send });
    expect(menu.map((item) => item.label ?? item.type)).toEqual(["Открыть A&D Voice", "separator", "Радио · Lofi", "Следующая станция", "separator", "Выйти"]);
    expect(menu[2]).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    (menu[3]!.click as () => void)();
    expect(send).toHaveBeenCalledWith({ type: "nextStation" });
  });

  it("hides to the tray only while the radio plays in the Library and the app is not quitting", () => {
    const shell = new DesktopShell();
    const window = { isDestroyed: () => false, hide: vi.fn(), show: vi.fn(), focus: vi.fn(), isMinimized: () => false, restore: vi.fn() };
    let quitting = false;
    const notify = vi.fn();
    const tray = createTrayRadio({
      window: () => window as never,
      shell,
      iconPath: () => "icon.png",
      notify,
      quit: vi.fn(),
      quitting: () => quitting,
    });
    expect(tray.closeToTray()).toBe(false);
    shell.report({ screen: "library", radio: { available: true, enabled: true, station: "Lofi" } });
    expect(electron.trays.at(-1)?.tooltip).toBe("A&D Voice · Lofi");
    quitting = true;
    expect(tray.closeToTray()).toBe(false);
    quitting = false;
    expect(tray.closeToTray()).toBe(true);
    expect(window.hide).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(tray.closeToTray()).toBe(true);
    // The explanation is given once per session.
    expect(notify).toHaveBeenCalledOnce();
    shell.report({ screen: "karaoke", radio: { available: false, enabled: false } });
    // Hidden in the tray, the icon stays even when the radio stops.
    expect(electron.trays.at(-1)?.destroyed).toBe(false);
  });
});

describe("jump list", () => {
  it("starts the app with a task argument, titled in the app's language", () => {
    const tasks = jumpListTasks("en");
    expect(tasks.map((task) => task.title)).toEqual(["Add song", "Online room"]);
    expect(tasks[0]!.arguments).toContain("--add-song");
    expect(tasks[1]!.arguments).toContain("--open-room");
  });
});

describe("Discord presence", () => {
  it("frames IPC messages and reads them back, even split across chunks", () => {
    const frame = encodeFrame(1, { cmd: "SET_ACTIVITY", args: { text: "Люди" } });
    expect(frame.readUInt32LE(0)).toBe(1);
    const first = decodeFrames(frame.subarray(0, 10));
    expect(first.frames).toEqual([]);
    const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(10), encodeFrame(2, {})]));
    expect(second.frames).toEqual([
      { op: 1, payload: { cmd: "SET_ACTIVITY", args: { text: "Люди" } } },
      { op: 2, payload: {} },
    ]);
    expect(second.rest.length).toBe(0);
  });

  it("shows the song, the radio or the room — never the room's code", () => {
    const singing = activityFor(
      status({ screen: "karaoke", song: { title: "Люди", artist: "Бумбокс" }, playing: true, room: { code: "SECRET", participants: 3 } }),
      1000,
    );
    expect(singing).toMatchObject({ details: "Поёт «Люди»", state: "Бумбокс", timestamps: { start: 1000 }, party: { size: [3, 8] } });
    expect(JSON.stringify(singing)).not.toContain("SECRET");
    expect(activityFor(status({ language: "en", screen: "library", radio: { available: true, enabled: true, station: "Lofi" } }), 0)).toMatchObject({
      details: "Listening to the radio",
      state: "Lofi",
    });
    expect(activityFor(status({ screen: "library" }), 0)?.details).toBe("В библиотеке");
  });
});

describe("updates", () => {
  it("compares versions numerically", () => {
    expect(isNewerVersion("v1.2.10", "1.2.9")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.1.9", "1.2.0")).toBe(false);
    expect(isNewerVersion("2.0.0-beta", "1.9.9")).toBe(true);
  });

  it("takes only a newer, final release's installer from GitHub's own hosts", () => {
    const release = (patch: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
      tag_name: "v1.3.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "AD-Voice-Setup.exe",
          browser_download_url: "https://github.com/Pro100Dimka/karaoke_new_version/releases/download/v1.3.0/AD-Voice-Setup.exe",
          size: 1234,
          digest: `sha256:${"ab".repeat(32)}`,
          ...asset,
        },
      ],
      ...patch,
    });
    expect(installerFromRelease(release(), "1.2.0")).toEqual({
      version: "1.3.0",
      url: "https://github.com/Pro100Dimka/karaoke_new_version/releases/download/v1.3.0/AD-Voice-Setup.exe",
      size: 1234,
      sha256: "ab".repeat(32),
    });
    expect(installerFromRelease(release(), "1.3.0")).toBeUndefined();
    expect(installerFromRelease(release({ prerelease: true }), "1.2.0")).toBeUndefined();
    expect(installerFromRelease(release({}, { browser_download_url: "https://evil.example/AD-Voice-Setup.exe" }), "1.2.0")).toBeUndefined();
    expect(installerFromRelease(release({}, { name: "other.exe" }), "1.2.0")).toBeUndefined();
    expect(installerFromRelease(release({}, { digest: undefined }), "1.2.0")?.sha256).toBeUndefined();
    // With both, the full installer is taken directly (the small one is for older versions).
    const both = release();
    both.assets.push({
      name: "AD-Voice-Setup-Full.exe",
      browser_download_url: "https://github.com/Pro100Dimka/karaoke_new_version/releases/download/v1.3.0/AD-Voice-Setup-Full.exe",
      size: 99,
      digest: `sha256:${"cd".repeat(32)}`,
    });
    expect(installerFromRelease(both, "1.2.0")).toMatchObject({ size: 99, sha256: "cd".repeat(32) });
  });
});

describe("texts and icons", () => {
  it("translates every desktop text into every language", () => {
    for (const language of shellLanguages)
      for (const key of shellTextKeys) expect(shellTextTable[language][key], `${language}.${key}`).toBeTruthy();
  });

  it("draws icons as premultiplied BGRA with soft edges", () => {
    const pixels = drawIcon(iconShapes.dot, [255, 0, 0], 16);
    expect(pixels.length).toBe(16 * 16 * 4);
    const at = (x: number, y: number) => [...pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(at(8, 8)).toEqual([0, 0, 255, 255]);
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
    // Some edge pixel is partly covered.
    expect([...Array(16).keys()].some((x) => { const a = at(x, 8)[3]!; return a > 0 && a < 255; })).toBe(true);
  });
});
