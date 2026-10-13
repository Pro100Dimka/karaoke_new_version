import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SettingsModal from "../..";
import type {
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";

const state = vi.hoisted(() => ({
  audio: {
    backend: "WASAPI Exclusive",
    sampleRate: 48000,
    periodFrames: 480,
  } as RequestedAudioConfiguration,
  runtime: {
    backend: "WASAPI Exclusive",
    sampleRate: 48000,
    periodFrames: 480,
    endpointBufferFrames: 480,
    estimatedLatencyMs: 17,
  } as RuntimeAudioConfiguration,
  apply: vi.fn<() => Promise<RuntimeAudioConfiguration>>(),
  readRuntime: vi.fn<() => Promise<RuntimeAudioConfiguration>>(),
  readDevices: vi.fn<() => Promise<readonly DeviceDto[]>>(),
  capabilities: vi.fn(async () => ({
    sampleRates: [48000],
    periodFrames: [480],
  })),
  updatePreferences: vi.fn(),
  notify: vi.fn(),
  devices: [] as DeviceDto[],
}));
vi.mock("../../../../app/AppContext", () => ({
  useSettingsDialog: () => ({
    settingsOpen: true,
    settingsTab: "audio",
    setSettingsOpen: vi.fn(),
  }),
  useApp: () => ({
    language: "ru",
    preferences: { audio: state.audio },
    updatePreferences: state.updatePreferences,
  }),
}));
vi.mock("../../../../app/NotificationsProvider", () => ({
  useNotify: () => state.notify,
}));
vi.mock("../../../../app/RadioContext", () => ({
  useRadio: () => ({
    stationId: "groove-salad",
    setStation: vi.fn(),
  }),
}));
vi.mock("../../../../services/audioClient", () => ({
  audioClient: {
    runtimeConfiguration: state.readRuntime,
    listDevices: state.readDevices,
    capabilities: async () => ({ microphone: "ready" }),
    configurationCapabilities: state.capabilities,
    applyConfiguration: state.apply,
  },
}));
vi.mock("./useAudioTests", () => ({ useAudioTests: () => ({}) }));
vi.mock(".", () => ({
  AudioSettings: ({
    form,
    onAudioCommit,
    asioUnavailable,
    audioAvailable,
    devices,
    configurationCapabilities,
  }: {
    form: {
      values: { backend: string };
      setValue(name: string, value: string): void;
    };
    onAudioCommit(name: string, value: string): void;
    asioUnavailable: boolean;
    audioAvailable: boolean;
    devices: readonly DeviceDto[];
    configurationCapabilities: { sampleRates: readonly number[] };
  }) => (
    <>
      <output>{form.values.backend}</output>
      <span data-testid="selected-input">{(form.values as { inputDeviceId?: string }).inputDeviceId}</span>
      <span data-testid="buffer-frames">{String((form.values as { bufferFrames?: number }).bufferFrames)}</span>
      <span data-testid="asio-unavailable">{String(asioUnavailable)}</span>
      <span data-testid="audio-available">{String(audioAvailable)}</span>
      <span data-testid="devices">{devices.map((device) => device.name).join(", ")}</span>
      <span data-testid="sample-rates">{configurationCapabilities.sampleRates.join(", ")}</span>
      <button
        onClick={() => {
          form.setValue("backend", "WASAPI Shared");
          onAudioCommit("backend", "WASAPI Shared");
        }}
      >
        select shared
      </button>
      <button
        onClick={() => {
          const id = state.devices.find(({ backend }) => backend === "ASIO")?.id ?? "flex-asio";
          form.setValue("inputDeviceId", id);
          onAudioCommit("inputDeviceId", id);
        }}
      >
        select ASIO driver
      </button>
    </>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.audio = {
    backend: "WASAPI Exclusive",
    sampleRate: 48000,
    periodFrames: 480,
  };
  state.runtime = {
    backend: "WASAPI Exclusive",
    sampleRate: 48000,
    periodFrames: 480,
    endpointBufferFrames: 480,
    estimatedLatencyMs: 17,
  };
  state.apply.mockRejectedValue(new Error("endpoint busy"));
  state.capabilities.mockReset().mockResolvedValue({
    sampleRates: [48000],
    periodFrames: [480],
  });
  state.devices = [];
  state.readRuntime.mockReset().mockImplementation(async () => state.runtime);
  state.readDevices.mockReset().mockImplementation(async () => state.devices);
});

it("releases the current driver before probing a newly selected ASIO driver", async () => {
  state.audio = { ...state.audio, backend: "ASIO", inputDeviceId: "old", outputDeviceId: "old" };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [{ id: "new", name: "New ASIO", backend: "ASIO", kind: "output", channels: 2 }];
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("true"));
  const calls: string[] = [];
  state.apply.mockImplementation(async () => { calls.push("apply"); return state.runtime; });
  state.capabilities.mockImplementation(async () => {
    calls.push("capabilities");
    return { sampleRates: [48000], periodFrames: [480] };
  });
  fireEvent.click(screen.getByText("select ASIO driver"));
  await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
  await waitFor(() => expect(calls).toContain("capabilities"));
  expect(calls[0]).toBe("apply");
});

it("restores the previous ASIO driver selection when the new driver fails", async () => {
  state.audio = { ...state.audio, backend: "ASIO", inputDeviceId: "working", outputDeviceId: "working" };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [{ id: "broken", name: "Broken ASIO", backend: "ASIO", kind: "output", channels: 2 }];
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("true"));
  fireEvent.click(screen.getByText("select ASIO driver"));
  await waitFor(() => expect(state.notify).toHaveBeenCalled());
  expect(screen.getByTestId("selected-input")).toHaveTextContent("working");
  expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("false");
});

it("keeps the newest selection visible while an earlier switch finishes", async () => {
  state.audio = { ...state.audio, backend: "ASIO", inputDeviceId: "old", outputDeviceId: "old" };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  const drivers = ["first", "last"].map(id => ({ id, name: id, backend: "ASIO" as const,
    kind: "output" as const, channels: 2 }));
  state.devices = drivers;
  let finishFirst!: (runtime: RuntimeAudioConfiguration) => void;
  let finishLast!: (runtime: RuntimeAudioConfiguration) => void;
  state.apply.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishLast = resolve; }));
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("true"));
  fireEvent.click(screen.getByText("select ASIO driver"));
  await waitFor(() => expect(state.apply).toHaveBeenCalledTimes(1));
  state.devices = [...drivers].reverse();
  fireEvent.click(screen.getByText("select ASIO driver"));
  finishFirst(state.runtime);
  await waitFor(() => expect(state.apply).toHaveBeenCalledTimes(2));
  try {
    expect(screen.getByTestId("selected-input")).toHaveTextContent("last");
    expect(state.updatePreferences).not.toHaveBeenCalled();
  } finally {
    finishLast(state.runtime);
    await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
  }
});

it.each(["WASAPI Exclusive", "ASIO"] as const)("recovers %s device choices when AudioService was unavailable when settings opened", async (backend) => {
  state.audio = { ...state.audio, backend };
  state.runtime = { ...state.runtime, backend };
  state.readRuntime.mockRejectedValueOnce(new Error("service starting"));
  state.readDevices.mockRejectedValueOnce(new Error("service starting"));
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("false"));
  state.devices = [{ id: "recovered", name: "Recovered speakers", kind: "output", channels: 2, backend }];

  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("true"), { timeout: 2500 });
  expect(screen.getByTestId("devices")).toHaveTextContent("Recovered speakers");
  expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("false");
});

it("marks a disconnected AudioService unavailable while settings remain open", async () => {
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("true"));
  state.readRuntime.mockRejectedValue(new Error("service stopped"));

  await waitFor(() => expect(screen.getByTestId("audio-available")).toHaveTextContent("false"), { timeout: 2500 });
});

it.each(["initial", "recovery"])("retries failed %s configuration capabilities without reopening settings", async (phase) => {
  state.audio = { ...state.audio, backend: "ASIO" };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.capabilities.mockRejectedValueOnce(new Error("capabilities not ready"));
  if (phase === "recovery") {
    state.readRuntime.mockRejectedValueOnce(new Error("service starting"));
    state.readDevices.mockRejectedValueOnce(new Error("service starting"));
    state.capabilities.mockRejectedValueOnce(new Error("capabilities not ready"));
  }
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("true"));

  await waitFor(() => expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("false"), { timeout: 3500 });
  expect(screen.getByTestId("sample-rates")).toHaveTextContent("48000");
  expect(screen.getByTestId("audio-available")).toHaveTextContent("true");
});

it("keeps working audio available when an unsupported ASIO capability query keeps failing", async () => {
  state.audio = { ...state.audio, backend: "ASIO", inputDeviceId: "unavailable-driver" };
  state.runtime = { ...state.runtime, backend: "WASAPI Shared" };
  state.capabilities.mockRejectedValue(new Error("unsupported ASIO driver"));
  render(<SettingsModal />);
  await waitFor(() => expect(state.readRuntime).toHaveBeenCalledTimes(3), { timeout: 3000 });

  expect(screen.getByTestId("audio-available")).toHaveTextContent("true");
  expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("true");
  expect(screen.getByRole("status")).toHaveTextContent("ASIO");
});

it("restores the accepted selection when switching fails", async () => {
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select shared"));
  await waitFor(() => expect(state.notify).toHaveBeenCalled());
  expect(screen.getByRole("status")).toHaveTextContent("WASAPI Exclusive");
});

it("keeps the accepted mode when only capabilities refresh fails", async () => {
  render(<SettingsModal />);
  const button = await screen.findByText("select shared");
  state.apply.mockResolvedValue({ ...state.runtime, backend: "WASAPI Shared" });
  state.capabilities.mockRejectedValue(new Error("query failed"));
  fireEvent.click(button);
  await waitFor(() =>
    expect(state.updatePreferences).toHaveBeenCalledWith({
      audio: expect.objectContaining({ backend: "WASAPI Shared" }),
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("WASAPI Shared");
  expect(state.notify).not.toHaveBeenCalled();
});

it("shows the active backend when saved preferences differ from AudioService", async () => {
  state.audio = {
    backend: "WASAPI Shared",
    sampleRate: 48000,
    periodFrames: 480,
  };
  state.runtime = { ...state.runtime, backend: "WASAPI Exclusive" };
  render(<SettingsModal />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("WASAPI Exclusive"),
  );
  await waitFor(() =>
    expect(state.capabilities).toHaveBeenLastCalledWith(
      expect.objectContaining({ backend: "WASAPI Exclusive" }),
    ),
  );
  expect(state.updatePreferences).not.toHaveBeenCalled();
});

it("keeps a registered ASIO driver selected when it could not open", async () => {
  state.audio = { backend: "ASIO", sampleRate: 48000, periodFrames: 0,
    bufferFrames: 256, inputDeviceId: "audient", outputDeviceId: "audient" };
  state.runtime = { ...state.runtime, backend: "WASAPI Shared" };
  state.devices = [
    {
      id: "audient",
      name: "Audient USB ASIO",
      kind: "output",
      channels: 2,
      backend: "ASIO",
    },
  ];
  render(<SettingsModal />);
  await waitFor(() =>
    expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("true"),
  );
  expect(screen.getByRole("status")).toHaveTextContent("ASIO");
  expect(state.capabilities).toHaveBeenCalledWith(expect.objectContaining({ backend: "ASIO" }));
});

it("keeps the ASIO buffer when its unavailable runtime falls back to Shared", async () => {
  state.audio = { backend: "ASIO", sampleRate: 48000, periodFrames: 0,
    bufferFrames: 256, inputDeviceId: "audient", outputDeviceId: "audient" };
  state.runtime = { ...state.runtime, backend: "WASAPI Shared", sampleRate: 44100,
    periodFrames: 441 };
  state.devices = [{ id: "audient", name: "Audient USB ASIO", kind: "output",
    channels: 0, backend: "ASIO" }];
  render(<SettingsModal />);
  await waitFor(() =>
    expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("true"),
  );
  expect(screen.getByTestId("buffer-frames")).toHaveTextContent("256");
});

it("reports a registered ASIO driver whose capability probe failed", async () => {
  state.audio = { backend: "ASIO", sampleRate: 48000, periodFrames: 480 };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [
    {
      id: "audient",
      name: "Audient USB ASIO",
      kind: "output",
      channels: 2,
      backend: "ASIO",
    },
  ];
  state.capabilities.mockRejectedValue(new Error("ASIO driver is offline"));
  render(<SettingsModal />);
  await waitFor(() =>
    expect(screen.getByTestId("asio-unavailable")).toHaveTextContent("true"),
  );
  expect(screen.getByRole("status")).toHaveTextContent("ASIO");
});

it("shows the ASIO driver error when applying a selected driver fails", async () => {
  state.audio = { backend: "ASIO", sampleRate: 48000, periodFrames: 0,
    bufferFrames: 256 };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [{ id: "flex-asio", name: "FlexASIO", kind: "output",
    channels: 2, backend: "ASIO" }];
  state.apply.mockRejectedValue(new Error("ASIO driver rejected 256-frame buffer"));

  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select ASIO driver"));

  await waitFor(() => expect(state.notify).toHaveBeenCalledWith(
    expect.stringContaining("ASIO driver rejected 256-frame buffer"), "error",
  ));
});

it("keeps ASIO input and output on the same driver when either device field changes", async () => {
  state.audio = { backend: "ASIO", sampleRate: 48000, periodFrames: 512 };
  state.runtime = { ...state.runtime, backend: "ASIO", periodFrames: 512 };
  state.devices = [
    {
      id: "flex-asio",
      name: "FlexASIO",
      kind: "output",
      channels: 2,
      backend: "ASIO",
    },
  ];
  state.apply.mockResolvedValue(state.runtime as RuntimeAudioConfiguration);
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select ASIO driver"));
  await waitFor(() =>
    expect(state.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "ASIO",
        inputDeviceId: "flex-asio",
        outputDeviceId: "flex-asio",
      }),
    ),
  );
});

it("clears ASIO driver ids before switching to a WASAPI backend", async () => {
  state.audio = {
    backend: "ASIO",
    sampleRate: 44100,
    periodFrames: 512,
    bufferFrames: 512,
    inputDeviceId: "asio4all",
    outputDeviceId: "asio4all",
  };
  state.runtime = {
    ...state.runtime,
    backend: "ASIO",
    sampleRate: 44100,
    periodFrames: 512,
  };
  state.devices = [
    {
      id: "asio4all",
      name: "ASIO4ALL v2",
      kind: "input",
      channels: 2,
      backend: "ASIO",
    },
    {
      id: "wasapi-in",
      name: "Default microphone",
      kind: "input",
      channels: 2,
      backend: "WASAPI Shared",
    },
    {
      id: "wasapi-out",
      name: "Default speakers",
      kind: "output",
      channels: 2,
      backend: "WASAPI Shared",
    },
  ];
  state.apply.mockResolvedValue({
    ...state.runtime,
    backend: "WASAPI Shared",
  } as RuntimeAudioConfiguration);
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select shared"));
  await waitFor(() =>
    expect(state.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "WASAPI Shared",
        inputDeviceId: undefined,
        outputDeviceId: undefined,
      }),
    ),
  );
});

it("keeps ASIO enabled when the user explicitly selects ASIO4ALL", async () => {
  state.audio = { backend: "ASIO", sampleRate: 48_000, periodFrames: 0 };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [{ id: "asio4all", name: "ASIO4ALL v2", kind: "output",
    channels: 0, backend: "ASIO" }];
  state.apply.mockResolvedValue(state.runtime as RuntimeAudioConfiguration);
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select ASIO driver"));
  await waitFor(() => expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
    backend: "ASIO", inputDeviceId: "asio4all", outputDeviceId: "asio4all",
    userSelectedAsio: true,
  })));
  expect(state.updatePreferences).toHaveBeenCalledWith({
    audio: expect.objectContaining({ backend: "ASIO", userSelectedAsio: true }),
  });
});

it("updates the shown backend when AudioService switches while settings stay open", async () => {
  render(<SettingsModal />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("WASAPI Exclusive"),
  );
  state.runtime = { ...state.runtime, backend: "WASAPI Shared" };
  await waitFor(
    () => expect(screen.getByRole("status")).toHaveTextContent("WASAPI Shared"),
    { timeout: 2500 },
  );
  await waitFor(() =>
    expect(state.capabilities).toHaveBeenLastCalledWith(
      expect.objectContaining({ backend: "WASAPI Shared" }),
    ),
  );
  expect(state.updatePreferences).not.toHaveBeenCalled();
});

it("does not replace a pending selection with the previous runtime mode", async () => {
  let accept: (runtime: RuntimeAudioConfiguration) => void = () => undefined;
  state.apply.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select shared"));
  await waitFor(() => expect(state.apply).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(screen.getByRole("status")).toHaveTextContent("WASAPI Shared");
  accept({ ...state.runtime, backend: "WASAPI Shared" });
  await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
});
