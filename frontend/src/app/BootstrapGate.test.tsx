import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapGate } from "./BootstrapGate";

const mocks = vi.hoisted(() => ({
  python: { kind: "starting" },
  appReady: vi.fn(),
  audio: { backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0 } as {
    backend: string; inputDeviceId?: string; outputDeviceId?: string; sampleRate: number; periodFrames: number;
  },
  updatePreferences: vi.fn(),
  listDevices: vi.fn(async () => [] as { id: string; name: string; backend: string }[]),
}));


vi.mock("../providers/application", () => ({
  useApp: () => ({ preferences: { audio: mocks.audio, acousticLatencyMs: {} },
    updatePreferences: mocks.updatePreferences }),
}));

vi.mock("../providers/dialog", () => ({ ask: vi.fn(async () => null) }));
vi.mock("../providers/notifications", () => ({ useNotify: () => vi.fn() }));
vi.mock("../services/audioClient", () => ({
  audioClient: {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
    setPreferredConfiguration: vi.fn(),
    setAcousticLatency: vi.fn(async () => undefined),
    rememberAcousticLatencies: vi.fn(async () => false),
    onLowLatencyMicrophoneFallback: vi.fn(() => () => undefined),
    acousticCalibrationState: vi.fn(async () => ({
      fingerprint: "", milliseconds: null, origin: "NONE", songPlaying: false, songEstimates: 0,
    })),
    listDevices: mocks.listDevices,
  },
}));
vi.mock("../services/desktopClient", () => ({
  desktopClient: { appReady: mocks.appReady },
}));

describe("BootstrapGate", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    mocks.python.kind = "starting";
    mocks.appReady.mockClear();
    mocks.audio = { backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0 };
    mocks.updatePreferences.mockClear();
    mocks.listDevices.mockResolvedValue([]);
  });

  it("persists an ASIO4ALL profile as Windows defaults at startup", async () => {
    mocks.audio = { backend: "ASIO", inputDeviceId: "asio4all",
      outputDeviceId: "asio4all", sampleRate: 48_000, periodFrames: 0 };
    mocks.listDevices.mockResolvedValue([{ id: "asio4all", name: "ASIO4ALL v2", backend: "ASIO" }]);
    render(<BootstrapGate><div>application</div></BootstrapGate>);
    await vi.waitFor(() => expect(mocks.updatePreferences).toHaveBeenCalledWith({
      audio: expect.objectContaining({ backend: "WASAPI Shared" }),
    }));
  });

  it("keeps the renderer empty while the native startup loader is visible", () => {
    const { container } = render(
      <BootstrapGate>
        <div>application</div>
      </BootstrapGate>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("reveals Electron only after the ready application has painted", async () => {
    mocks.python.kind = "ready";
    vi.useFakeTimers();

    render(
      <BootstrapGate>
        <div>application background</div>
      </BootstrapGate>,
    );

    expect(mocks.appReady).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersToNextFrame());
    expect(mocks.appReady).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersToNextFrame());
    expect(mocks.appReady).toHaveBeenCalledOnce();
  });
});

vi.mock("../providers/store", () => ({ store: {
  get application() { return { services: { python: mocks.python, probe: vi.fn() } }; },
  get preferences() { return { audio: mocks.audio, acousticLatencyMs: {} }; },
  get updatePreferences() { return mocks.updatePreferences; }
} }));
