import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AcousticCalibrationState } from "../contracts/clients";
import { useAcousticLatencyAutoSave } from "./useAcousticLatencyAutoSave";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  remember: vi.fn(async () => false),
  measure: vi.fn(),
  ask: vi.fn(),
  notify: vi.fn(),
  updatePreferences: vi.fn(),
  stored: {} as Record<string, number>,
}));
vi.mock("../services/audioClient", () => ({
  audioClient: {
    acousticCalibrationState: mocks.state,
    rememberAcousticLatencies: mocks.remember,
    measureAcousticLatency: mocks.measure,
  },
}));
vi.mock("./AppContext", () => ({
  useApp: () => ({
    preferences: { acousticLatencyMs: mocks.stored },
    updatePreferences: mocks.updatePreferences,
  }),
}));
vi.mock("./DialogProvider", () => ({ useAsk: () => mocks.ask }));
vi.mock("./NotificationsProvider", () => ({ useNotify: () => mocks.notify }));
vi.mock("../i18n/useText", () => ({ useText: () => (key: string) => key }));

const path = "WASAPI Shared,{mic},{out},48000,48000,480,480,1056,1056";
const state = (overrides: Partial<AcousticCalibrationState>): AcousticCalibrationState => ({
  fingerprint: path,
  milliseconds: null,
  origin: "NONE",
  songPlaying: false,
  songEstimates: 0,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.stored = {};
});

const run = async (checks: number) => {
  vi.useFakeTimers();
  const hook = renderHook(() => useAcousticLatencyAutoSave());
  await vi.advanceTimersByTimeAsync(5_000 * (checks - 1));
  hook.unmount();
};

it("hands the saved calibrations to AudioService as soon as the app starts", async () => {
  mocks.stored = { [path]: 44.7 };
  mocks.state.mockResolvedValue(state({ milliseconds: 44.7, origin: "PROFILE" }));
  await run(1);
  expect(mocks.remember).toHaveBeenCalledWith({ [path]: 44.7 });
  expect(mocks.updatePreferences).not.toHaveBeenCalled();
});

it("saves the delay AudioService determined from the song for the path it belongs to", async () => {
  const other = "WASAPI Exclusive,{mic},{out},48000,48000,480,480,480,480";
  mocks.stored = { [other]: 17.6 };
  mocks.state.mockResolvedValue(state({ milliseconds: 45.23, origin: "SONG", songEstimates: 3 }));
  await run(1);
  expect(mocks.updatePreferences).toHaveBeenCalledWith({
    acousticLatencyMs: { [other]: 17.6, [path]: 45.2 },
  });
});

it("does not resave a restored profile or a value within the estimate's agreement", async () => {
  mocks.stored = { [path]: 45 };
  mocks.state.mockResolvedValueOnce(state({ milliseconds: 45, origin: "PROFILE" }));
  mocks.state.mockResolvedValueOnce(state({ milliseconds: 45.6, origin: "SONG" }));
  await run(2);
  expect(mocks.updatePreferences).not.toHaveBeenCalled();
});

it("asks once, after a song gave no estimate, before playing test signals", async () => {
  mocks.ask.mockResolvedValue("measure");
  mocks.measure.mockResolvedValue({ milliseconds: 21.4, fingerprint: path });
  mocks.state
    .mockResolvedValueOnce(state({ songPlaying: true }))
    .mockResolvedValue(state({}));
  await run(3);
  expect(mocks.ask).toHaveBeenCalledOnce();
  expect(mocks.measure).toHaveBeenCalledOnce();
  expect(mocks.updatePreferences).toHaveBeenCalledWith({ acousticLatencyMs: { [path]: 21.4 } });
});

it("never asks during a song, before any song, or when the song already gave the delay", async () => {
  mocks.state
    .mockResolvedValueOnce(state({}))
    .mockResolvedValueOnce(state({ songPlaying: true }))
    .mockResolvedValue(state({ songEstimates: 2 }));
  await run(3);
  expect(mocks.ask).not.toHaveBeenCalled();
  expect(mocks.measure).not.toHaveBeenCalled();
});

it("plays nothing when the user postpones", async () => {
  mocks.ask.mockResolvedValue("later");
  mocks.state.mockResolvedValueOnce(state({ songPlaying: true })).mockResolvedValue(state({}));
  await run(3);
  expect(mocks.ask).toHaveBeenCalledOnce();
  expect(mocks.measure).not.toHaveBeenCalled();
});
