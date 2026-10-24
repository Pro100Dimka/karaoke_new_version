import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultPreferences,
  type Preferences,
} from "../../../../../../../shared/preferences/preferences";
import { useKeyboardLighting } from "../useKeyboardLighting";

const service = vi.hoisted(() => ({
  capabilities: vi.fn(),
  apply: vi.fn(),
  notify: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../../../../../../app/AppContext", () => ({
  useApp: () => {
    const [preferences, setPreferences] = useState<Preferences>(() => ({
      ...defaultPreferences(),
      keyboardLighting: {
        enabled: false,
        mode: "theme" as const,
        brightness: 50,
        sensitivity: 50,
      },
    }));
    return {
      preferences,
      updatePreferences: (patch: Partial<Preferences>) => {
        service.save(patch);
        setPreferences((current) => ({ ...current, ...patch }));
      },
    };
  },
}));
vi.mock("../../../../../SettingsProvider", () => ({
  useSettingsLighting: () => service,
}));
vi.mock("../../../../../../../app/NotificationsProvider", () => ({
  useNotify: () => service.notify,
}));
vi.mock("../../../../../../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));

const available = { available: true, provider: "OpenRGB", deviceCount: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  service.capabilities.mockReset().mockResolvedValue(available);
  service.apply.mockReset().mockResolvedValue(undefined);
  service.notify.mockReset();
  service.save.mockReset();
});
afterEach(() => {
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
  const { result } = renderHook(useKeyboardLighting);
  await act(async () => {});
  await act(async () => result.current.update({ enabled: true }));
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
    "settingsApplyFailed: Lighting disconnected",
    "error",
  );
});
