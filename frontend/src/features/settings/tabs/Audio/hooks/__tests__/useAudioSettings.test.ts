import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from "../../../../../../contracts/models";
import { useAudioSettings } from "../useAudioSettings";

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
  playTestSound: vi.fn(async () => undefined),
  readRuntime: vi.fn<() => Promise<RuntimeAudioConfiguration>>(),
  readDevices: vi.fn<() => Promise<readonly DeviceDto[]>>(),
  capabilities: vi.fn(async () => ({
    sampleRates: [48000],
    periodFrames: [480],
  })),
  theme: "dark",
  updatePreferences: vi.fn(),
  notify: vi.fn(),
  devices: [] as DeviceDto[],
}));
vi.mock("../../../../../../app/AppContext", () => ({
  useApp: () => ({
    preferences: { audio: state.audio, theme: state.theme },
    updatePreferences: state.updatePreferences,
  }),
}));
vi.mock("../../../../../../app/NotificationsProvider", () => ({
  useNotify: () => state.notify,
}));
vi.mock("../../../../../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));
vi.mock("../../../../../../app/SettingsProvider", () => {
  const audio = {
    runtimeConfiguration: state.readRuntime,
    listDevices: state.readDevices,
    capabilities: async () => ({ microphone: "ready" }),
    configurationCapabilities: state.capabilities,
    applyConfiguration: state.apply,
    playTestSound: state.playTestSound,
  };
  return { useSettingsAudio: () => audio };
});

const loadSettings = async () => {
  const hook = renderHook(() => useAudioSettings());
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  return hook;
};
const selectAsio = (result: {
  current: ReturnType<typeof useAudioSettings>;
}) => {
  const id =
    state.devices.find(({ backend }) => backend === "ASIO")?.id ?? "flex-asio";
  act(() => result.current.audio.onAudioCommit("inputDeviceId", id));
};

beforeEach(() => {
  vi.clearAllMocks();
  state.theme = "dark";
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
  state.playTestSound.mockReset().mockResolvedValue(undefined);
  state.capabilities.mockReset().mockResolvedValue({
    sampleRates: [48000],
    periodFrames: [480],
  });
  state.devices = [];
  state.readRuntime.mockReset().mockImplementation(async () => state.runtime);
  state.readDevices.mockReset().mockImplementation(async () => state.devices);
});

it("reports an output test failure without changing the requested configuration", async () => {
  state.playTestSound.mockRejectedValueOnce(new Error("speaker unavailable"));
  const { result } = await loadSettings();
  await act(async () => result.current.audio.onPlayTestSound());
  await waitFor(() =>
    expect(state.notify).toHaveBeenCalledWith(
      expect.stringContaining("speaker unavailable"),
      "error",
    ),
  );
  expect(state.apply).not.toHaveBeenCalled();
  expect(state.updatePreferences).not.toHaveBeenCalled();
});

it("releases the current driver before probing a newly selected ASIO driver", async () => {
  state.audio = {
    ...state.audio,
    backend: "ASIO",
    inputDeviceId: "old",
    outputDeviceId: "old",
  };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [
    {
      id: "new",
      name: "New ASIO",
      backend: "ASIO",
      kind: "output",
      channels: 2,
    },
  ];
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.audioAvailable).toBe(true));
  const calls: string[] = [];
  state.apply.mockImplementation(async () => {
    calls.push("apply");
    return state.runtime;
  });
  state.capabilities.mockImplementation(async () => {
    calls.push("capabilities");
    return { sampleRates: [48000], periodFrames: [480] };
  });
  selectAsio(result);
  await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
  await waitFor(() => expect(calls).toContain("capabilities"));
  expect(calls[0]).toBe("apply");
});

it("restores the previous ASIO driver selection when the new driver fails", async () => {
  state.audio = {
    ...state.audio,
    backend: "ASIO",
    inputDeviceId: "working",
    outputDeviceId: "working",
  };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [
    {
      id: "broken",
      name: "Broken ASIO",
      backend: "ASIO",
      kind: "output",
      channels: 2,
    },
  ];
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.audioAvailable).toBe(true));
  selectAsio(result);
  await waitFor(() => expect(state.notify).toHaveBeenCalled());
  expect(result.current.audio.values.inputDeviceId).toBe("working");
  expect(result.current.audio.asioUnavailable).toBe(false);
});

it("keeps the newest request while an earlier switch finishes", async () => {
  state.audio = {
    ...state.audio,
    backend: "ASIO",
    inputDeviceId: "old",
    outputDeviceId: "old",
  };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  const drivers = ["first", "last"].map((id) => ({
    id,
    name: id,
    backend: "ASIO" as const,
    kind: "output" as const,
    channels: 2,
  }));
  state.devices = drivers;
  let finishFirst!: (runtime: RuntimeAudioConfiguration) => void;
  let finishLast!: (runtime: RuntimeAudioConfiguration) => void;
  state.apply
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLast = resolve;
        }),
    );
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.audioAvailable).toBe(true));
  selectAsio(result);
  await waitFor(() => expect(state.apply).toHaveBeenCalledTimes(1));
  state.devices = [...drivers].reverse();
  selectAsio(result);
  finishFirst(state.runtime);
  await waitFor(() => expect(state.apply).toHaveBeenCalledTimes(2));
  try {
    expect(result.current.audio.values.inputDeviceId).toBe("last");
    expect(state.updatePreferences).not.toHaveBeenCalled();
  } finally {
    finishLast(state.runtime);
    await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
  }
});

it.each(["WASAPI Exclusive", "ASIO"] as const)(
  "recovers %s device choices when AudioService was unavailable when settings opened",
  async (backend) => {
    state.audio = { ...state.audio, backend };
    state.runtime = { ...state.runtime, backend };
    state.readRuntime.mockRejectedValueOnce(new Error("service starting"));
    state.readDevices.mockRejectedValueOnce(new Error("service starting"));
    const { result } = await loadSettings();
    await waitFor(() =>
      expect(result.current.audio.audioAvailable).toBe(false),
    );
    state.devices = [
      {
        id: "recovered",
        name: "Recovered speakers",
        kind: "output",
        channels: 2,
        backend,
      },
    ];

    await waitFor(
      () => expect(result.current.audio.audioAvailable).toBe(true),
      { timeout: 2500 },
    );
    expect(result.current.audio.devices).toEqual([
      expect.objectContaining({ id: "recovered" }),
    ]);
    expect(result.current.audio.asioUnavailable).toBe(false);
  },
);

it("marks a disconnected AudioService unavailable while settings remain open", async () => {
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.audioAvailable).toBe(true));
  state.readRuntime.mockRejectedValue(new Error("service stopped"));

  await waitFor(() => expect(result.current.audio.audioAvailable).toBe(false), {
    timeout: 2500,
  });
});

it.each(["initial", "recovery"])(
  "retries failed %s configuration capabilities without reopening settings",
  async (phase) => {
    state.audio = { ...state.audio, backend: "ASIO" };
    state.runtime = { ...state.runtime, backend: "ASIO" };
    state.capabilities.mockRejectedValueOnce(
      new Error("capabilities not ready"),
    );
    if (phase === "recovery") {
      state.readRuntime.mockRejectedValueOnce(new Error("service starting"));
      state.readDevices.mockRejectedValueOnce(new Error("service starting"));
      state.capabilities.mockRejectedValueOnce(
        new Error("capabilities not ready"),
      );
    }
    const { result } = await loadSettings();
    await waitFor(() =>
      expect(result.current.audio.asioUnavailable).toBe(true),
    );

    await waitFor(
      () => expect(result.current.audio.asioUnavailable).toBe(false),
      { timeout: 3500 },
    );
    expect(result.current.audio.configurationCapabilities.sampleRates).toEqual([
      48000,
    ]);
    expect(result.current.audio.audioAvailable).toBe(true);
  },
);

it("keeps working audio available when an unsupported ASIO capability query keeps failing", async () => {
  state.audio = {
    ...state.audio,
    backend: "ASIO",
    inputDeviceId: "unavailable-driver",
  };
  state.runtime = { ...state.runtime, backend: "WASAPI Shared" };
  state.capabilities.mockRejectedValue(new Error("unsupported ASIO driver"));
  const { result } = await loadSettings();
  await waitFor(() => expect(state.readRuntime).toHaveBeenCalledTimes(3), {
    timeout: 3000,
  });

  expect(result.current.audio.audioAvailable).toBe(true);
  expect(result.current.audio.asioUnavailable).toBe(true);
  expect(result.current.audio.values.backend).toBe("ASIO");
});

it("restores the accepted selection when switching fails", async () => {
  const { result } = await loadSettings();
  act(() => result.current.audio.onAudioCommit("backend", "WASAPI Shared"));
  await waitFor(() => expect(state.notify).toHaveBeenCalled());
  expect(result.current.audio.values.backend).toBe("WASAPI Exclusive");
});

it("keeps the accepted mode when only capabilities refresh fails", async () => {
  const { result } = await loadSettings();
  state.apply.mockResolvedValue({ ...state.runtime, backend: "WASAPI Shared" });
  state.capabilities.mockRejectedValue(new Error("query failed"));
  act(() => result.current.audio.onAudioCommit("backend", "WASAPI Shared"));
  await waitFor(() =>
    expect(state.updatePreferences).toHaveBeenCalledWith({
      audio: expect.objectContaining({ backend: "WASAPI Shared" }),
    }),
  );
  expect(result.current.audio.values.backend).toBe("WASAPI Shared");
  expect(state.notify).not.toHaveBeenCalled();
});

it("uses the active backend for capability queries without overwriting saved preferences", async () => {
  state.audio = {
    backend: "WASAPI Shared",
    sampleRate: 48000,
    periodFrames: 480,
  };
  state.runtime = { ...state.runtime, backend: "WASAPI Exclusive" };
  const { result } = await loadSettings();
  await waitFor(() =>
    expect(result.current.audio.values.backend).toBe("WASAPI Exclusive"),
  );
  await waitFor(() =>
    expect(state.capabilities).toHaveBeenLastCalledWith(
      expect.objectContaining({ backend: "WASAPI Exclusive" }),
    ),
  );
  expect(state.updatePreferences).not.toHaveBeenCalled();
});

it("keeps a registered ASIO driver selected when it could not open", async () => {
  state.audio = {
    backend: "ASIO",
    sampleRate: 48000,
    periodFrames: 0,
    bufferFrames: 256,
    inputDeviceId: "audient",
    outputDeviceId: "audient",
  };
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
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.asioUnavailable).toBe(true));
  expect(result.current.audio.values.backend).toBe("ASIO");
  expect(state.capabilities).toHaveBeenCalledWith(
    expect.objectContaining({ backend: "ASIO" }),
  );
});

it("keeps the ASIO buffer when its unavailable runtime falls back to Shared", async () => {
  state.audio = {
    backend: "ASIO",
    sampleRate: 48000,
    periodFrames: 0,
    bufferFrames: 256,
    inputDeviceId: "audient",
    outputDeviceId: "audient",
  };
  state.runtime = {
    ...state.runtime,
    backend: "WASAPI Shared",
    sampleRate: 44100,
    periodFrames: 441,
  };
  state.devices = [
    {
      id: "audient",
      name: "Audient USB ASIO",
      kind: "output",
      channels: 0,
      backend: "ASIO",
    },
  ];
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.asioUnavailable).toBe(true));
  expect(result.current.audio.values.bufferFrames).toBe(256);
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
  const { result } = await loadSettings();
  await waitFor(() => expect(result.current.audio.asioUnavailable).toBe(true));
  expect(result.current.audio.values.backend).toBe("ASIO");
});

it("reports the error when applying a selected ASIO driver fails", async () => {
  state.audio = {
    backend: "ASIO",
    sampleRate: 48000,
    periodFrames: 0,
    bufferFrames: 256,
  };
  state.runtime = { ...state.runtime, backend: "ASIO" };
  state.devices = [
    {
      id: "flex-asio",
      name: "FlexASIO",
      kind: "output",
      channels: 2,
      backend: "ASIO",
    },
  ];
  state.apply.mockRejectedValue(
    new Error("ASIO driver rejected 256-frame buffer"),
  );

  const { result } = await loadSettings();
  selectAsio(result);

  await waitFor(() =>
    expect(state.notify).toHaveBeenCalledWith(
      expect.stringContaining("ASIO driver rejected 256-frame buffer"),
      "error",
    ),
  );
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
  const { result } = await loadSettings();
  selectAsio(result);
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
  const { result } = await loadSettings();
  act(() => result.current.audio.onAudioCommit("backend", "WASAPI Shared"));
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
  state.devices = [
    {
      id: "asio4all",
      name: "ASIO4ALL v2",
      kind: "output",
      channels: 0,
      backend: "ASIO",
    },
  ];
  state.apply.mockResolvedValue(state.runtime as RuntimeAudioConfiguration);
  const { result } = await loadSettings();
  selectAsio(result);
  await waitFor(() =>
    expect(state.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "ASIO",
        inputDeviceId: "asio4all",
        outputDeviceId: "asio4all",
        userSelectedAsio: true,
      }),
    ),
  );
  expect(state.updatePreferences).toHaveBeenCalledWith({
    audio: expect.objectContaining({ backend: "ASIO", userSelectedAsio: true }),
  });
});

it("tracks an external backend switch without saving it as a user request", async () => {
  const { result } = await loadSettings();
  await waitFor(() =>
    expect(result.current.audio.values.backend).toBe("WASAPI Exclusive"),
  );
  state.runtime = { ...state.runtime, backend: "WASAPI Shared" };
  await waitFor(
    () => expect(result.current.audio.values.backend).toBe("WASAPI Shared"),
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
  const { result } = await loadSettings();
  act(() => result.current.audio.onAudioCommit("backend", "WASAPI Shared"));
  await waitFor(() => expect(state.apply).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(result.current.audio.values.backend).toBe("WASAPI Shared");
  accept({ ...state.runtime, backend: "WASAPI Shared" });
  await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
});

it("keeps automatic request values when an unrelated setting changes", async () => {
  state.audio = {
    backend: "ASIO",
    sampleRate: 0,
    periodFrames: 0,
    bufferFrames: 0,
    inputDeviceId: "audient",
    outputDeviceId: "audient",
    userSelectedAsio: true,
  };
  state.runtime = {
    backend: "ASIO",
    sampleRate: 44100,
    periodFrames: 128,
    endpointBufferFrames: 256,
    estimatedLatencyMs: 6,
  };
  state.devices = [
    {
      id: "audient",
      name: "Audient",
      backend: "ASIO",
      kind: "output",
      channels: 2,
    },
  ];
  state.capabilities.mockResolvedValue({
    sampleRates: [44100, 48000],
    periodFrames: [128, 256],
  });
  state.apply.mockResolvedValue({ ...state.runtime, periodFrames: 256 });
  const { result } = await loadSettings();
  await waitFor(() =>
    expect(result.current.audio.values.sampleRate).toBe(44100),
  );
  act(() => result.current.audio.onAudioCommit("bufferFrames", 256));
  await waitFor(() =>
    expect(state.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "ASIO",
        sampleRate: 0,
        periodFrames: 0,
        bufferFrames: 256,
      }),
    ),
  );
  expect(state.updatePreferences).toHaveBeenCalledWith({
    audio: expect.objectContaining({ sampleRate: 0, bufferFrames: 256 }),
  });
});

it("keeps an unavailable ASIO request when an unrelated preference is saved", async () => {
  const { result, rerender } = await loadSettings();
  act(() => result.current.audio.onAudioCommit("backend", "ASIO"));
  expect(result.current.audio.values.backend).toBe("ASIO");
  state.updatePreferences.mockImplementationOnce((patch: { theme: string }) => {
    state.theme = patch.theme;
  });
  act(() => {
    state.updatePreferences({ theme: "light" });
    rerender();
  });
  expect(result.current.audio.values.backend).toBe("ASIO");
  expect(state.apply).not.toHaveBeenCalled();
});
