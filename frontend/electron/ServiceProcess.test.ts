import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ ...processMocks, default: processMocks }));

import { ServiceProcess } from "./ServiceProcess";

const childProcess = (pid: number) => Object.assign(new EventEmitter(), {
  pid,
  stdout: new EventEmitter(),
  stderr: new EventEmitter(),
  kill: vi.fn(),
});

describe("service process lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    processMocks.spawn.mockReset();
    processMocks.spawnSync.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it("coalesces error and exit into one pending restart", () => {
    const child = childProcess(101);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess("service.exe", [], "D:/app");

    service.start();
    child.emit("error", new Error("failed"));
    child.emit("exit", 1);

    expect(vi.getTimerCount()).toBe(1);
  });

  it("cancels a pending restart when the application stops", () => {
    const child = childProcess(202);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess("service.exe", [], "D:/app");

    service.start();
    child.emit("exit", 1);
    service.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(processMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("kills only the process tree owned by the application", () => {
    const child = childProcess(303);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess("service.exe", [], "D:/app");

    service.start();
    service.stop();

    expect(processMocks.spawnSync).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "303", "/T", "/F"],
      { windowsHide: true },
    );
  });
});
