import { afterEach, expect, it, vi } from "vitest";
import type { App } from "electron";
import * as path from "node:path";
import { configureRuntimeIdentity } from "./RuntimeIdentity";

afterEach(() => vi.unstubAllEnvs());

it("lets the operating system allocate the managed backend port", () => {
  vi.stubEnv("AD_VOICE_PORT", undefined);
  const app = { isPackaged: false, getPath: () => "D:/profiles", setName: vi.fn(), setPath: vi.fn() };
  configureRuntimeIdentity(app as unknown as App);
  expect(process.env.AD_VOICE_PORT).toBe("0");
});

it("isolates audio endpoints for custom profiles without a manually assigned pipe", () => {
  const endpoints: string[] = [];
  for (const profile of ["AD Voice Dev", "guest one", "guest two"]) {
    vi.stubEnv("AD_VOICE_PROFILE", profile);
    vi.stubEnv("AD_VOICE_AUDIO_ENDPOINT", undefined);
    configureRuntimeIdentity({ isPackaged: false, getPath: () => "D:/profiles", setName: vi.fn(), setPath: vi.fn() } as unknown as App);
    endpoints.push(process.env.AD_VOICE_AUDIO_ENDPOINT ?? "");
  }
  expect(new Set(endpoints).size).toBe(3);
});

it.each([".", "..", "CON", "NUL.config", "COM1", "LPT²", "profile."])(
  "keeps the profile inside AppData for invalid Windows directory %s", profile => {
    vi.stubEnv("AD_VOICE_PROFILE", profile);
    const app = { isPackaged: false, getPath: () => "D:/profiles", setName: vi.fn(), setPath: vi.fn() };
    configureRuntimeIdentity(app as unknown as App);
    expect(app.setPath).toHaveBeenCalledWith("userData", path.join("D:/profiles", "AD Voice Dev"));
  },
);
