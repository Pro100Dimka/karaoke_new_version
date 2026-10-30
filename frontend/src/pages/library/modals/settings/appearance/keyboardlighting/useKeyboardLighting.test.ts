import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultPreferences, type Preferences,
} from "../../../../../../shared/preferences/preferences";
import { useKeyboardLighting } from "./useKeyboardLighting";

const service = vi.hoisted(() => ({
  capabilities: vi.fn(),
  apply: vi.fn(),
  notify: vi.fn(),
  save: vi.fn(),
  preferences: {} as Preferences,
}));
vi.mock("../../../../../../providers/store", () => ({ store: {
  get preferences() { return service.preferences; },
  updatePreferences(patch: Partial<Preferences>) {
    service.save(patch);
    service.preferences = { ...service.preferences, ...patch };
  },
} }));
vi.mock("../../../../../../services/keyboardLightingClient", () => ({
  keyboardLightingClient: service,
}));
vi.mock("../../../../../../providers/notifications", () => ({
  useNotify: () => service.notify,
}));


const available = { available: true, provider: "OpenRGB", deviceCount: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  service.preferences = { ...defaultPreferences(), keyboardLighting: { enabled: false, mode: "theme", brightness: 50, sensitivity: 50 } };
  service.capabilities.mockReset().mockResolvedValue(available);
  service.apply.mockReset().mockResolvedValue(undefined);
  service.notify.mockReset();
  service.save.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.useRealTimers();
});

it("retries failed device discovery and stops polling on unmount", async () => {
  service.capabilities.mockRejectedValueOnce(new Error("Device unavailable"));
  const { result, unmount } = renderHook(useKeyboardLighting);
  await act(async () => {});
  expect(result.current.capabilities).toBeUndefined();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(result.current.capabilities).toEqual(available);
  expect(service.capabilities).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(service.capabilities).toHaveBeenCalledTimes(2);
});

it("does not overlap slow discovery requests or update a closed view", async () => {
  let finish!: (value: typeof available) => void;
  service.capabilities.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(useKeyboardLighting);
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(service.capabilities).toHaveBeenCalledOnce();
  unmount();
  await act(async () => finish(available));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(service.capabilities).toHaveBeenCalledOnce();
  expect(result.current.capabilities).toBeUndefined();
});

it("saves the requested lighting settings and reports a failed hardware change", async () => {
  service.apply.mockRejectedValueOnce(new Error("Lighting disconnected"));
  const { result, rerender } = renderHook(useKeyboardLighting);
  await act(async () => {});
  await act(async () => result.current.update({ enabled: true }));
  rerender();
  expect(result.current.lighting.enabled).toBe(true);
  expect(service.save).toHaveBeenCalledWith({
    keyboardLighting: {
      enabled: true,
      mode: "theme",
      brightness: 50,
      sensitivity: 50,
    },
  });
  expect(service.apply).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: true }),
    "dark",
  );
  expect(service.notify).toHaveBeenCalledWith(
    "Не удалось применить настройки: Lighting disconnected",
    "error",
  );
});
