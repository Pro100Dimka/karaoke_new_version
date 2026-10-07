import { expect, it, vi } from "vitest";
import type { ServiceObserver } from "./ServiceProcess";

const mocks = vi.hoisted(() => ({
  services: [] as { command: string; env: NodeJS.ProcessEnv; observer: ServiceObserver }[],
}));

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("./AppPaths", () => ({
  audioExecutable: () => "D:/app/AudioService.exe",
  projectRoot: () => "D:/app",
  pythonRoot: () => "D:/app/python",
}));
vi.mock("./ServiceProcess", () => ({
  ServiceProcess: class {
    constructor(command: string, _args: string[], _cwd: string, env: NodeJS.ProcessEnv, observer: ServiceObserver) {
      mocks.services.push({ command, env, observer });
    }
    start() {}
  },
}));

it("sends Python and AudioService stdout and stderr to the log without losing backend readiness", async () => {
  const { ManagedServices } = await import("./ManagedServices");
  const endpoint = { started: vi.fn(), stopped: vi.fn(), stdout: vi.fn() };
  const log = vi.fn();
  new ManagedServices(endpoint as never, log).start("D:/data");
  const python = mocks.services.find((service) => service.command !== "D:/app/AudioService.exe");
  const audio = mocks.services.find((service) => service.command === "D:/app/AudioService.exe");
  const ready = Buffer.from("AD_VOICE_BACKEND_READY:12345\n");
  const failed = Buffer.from("WASAPI: Start failed\n");
  python?.observer.stdout?.(ready);
  audio?.observer.stderr?.(failed);
  expect(endpoint.stdout).toHaveBeenCalledWith(ready);
  expect(log.mock.calls).toEqual([
    ["python", "info", ready],
    ["audio-service", "error", failed],
  ]);
  expect(python?.env.PYTHONIOENCODING).toBe("utf-8");
});
