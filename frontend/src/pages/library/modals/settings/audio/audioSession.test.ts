import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsAudioPort } from "../../../../../application/settings/SettingsPorts";
import type {
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from "../../../../../contracts/models";
import {
  createAudioSession,
  audioSessionFor,
  type AudioCommitEffects,
} from "./audioSession";

const initial: RequestedAudioConfiguration = {
  backend: "ASIO",
  sampleRate: 48000,
  periodFrames: 0,
  bufferFrames: 128,
  inputDeviceId: "original",
  outputDeviceId: "original",
};
const runtime: RuntimeAudioConfiguration = {
  backend: "ASIO",
  sampleRate: 48000,
  periodFrames: 128,
  endpointBufferFrames: 256,
  estimatedLatencyMs: 6,
  calibrationContext: "original",
};
const configuration = {
  sampleRates: [48000],
  periodFrames: [128, 256],
  defaultSampleRate: 48000,
  defaultPeriodFrames: 128,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const requestFor = (id: string): RequestedAudioConfiguration => ({
  ...initial,
  inputDeviceId: id,
  outputDeviceId: id,
});
const controllers: ReturnType<typeof createAudioSession>[] = [];
const fixture = () => {
  const audio = {
    runtimeConfiguration: vi.fn(async () => runtime),
    listDevices: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({
      microphone: "ready",
      keyboardLighting: false,
    })),
    configurationCapabilities: vi.fn(async () => configuration),
    applyConfiguration: vi.fn(async () => runtime),
    setPreferredConfiguration: vi.fn(async () => undefined),
  };
  const onChange = vi.fn();
  const onAccepted = vi.fn();
  const onError = vi.fn();
  const session = audioSessionFor(
    audio as unknown as SettingsAudioPort,
    initial,
  );
  const effects = { onAccepted, onError };
  const controller = {
    ...session,
    apply: (
      request: RequestedAudioConfiguration,
      handlers: AudioCommitEffects = effects,
    ) => session.apply(request, handlers),
    prepareAsio: (
      request: RequestedAudioConfiguration,
      driver: Parameters<typeof session.prepareAsio>[1],
      handlers: AudioCommitEffects = effects,
    ) => session.prepareAsio(request, driver, handlers),
  };
  const unsubscribe = session.subscribe(() => onChange(session.getSnapshot()));
  controllers.push(controller);
  return { audio, controller, onChange, onAccepted, onError, unsubscribe };
};

describe("audio settings session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.stop();
    vi.useRealTimers();
  });

  it("retries microphone capabilities independently of a healthy runtime", async () => {
    const { audio, controller } = fixture();
    audio.capabilities.mockRejectedValueOnce(new Error("not ready"));
    await controller.start();
    expect(controller.getSnapshot().audioAvailable).toBe(true);
    expect(controller.getSnapshot().capabilities.microphone).toBe("missing");
    await controller.refresh();
    expect(controller.getSnapshot().capabilities.microphone).toBe("ready");
    expect(audio.capabilities).toHaveBeenCalledTimes(2);
  });

  it("retries a failed device query without discarding the live runtime", async () => {
    const { audio, controller } = fixture();
    audio.listDevices.mockRejectedValueOnce(new Error("enumeration failed"));
    await controller.start();
    expect(controller.getSnapshot().audioAvailable).toBe(false);
    await controller.refresh();
    expect(controller.getSnapshot().audioAvailable).toBe(true);
    expect(audio.listDevices).toHaveBeenCalledTimes(2);
  });

  it("retries configuration capabilities after a successful switch even when runtime is unchanged", async () => {
    const { audio, controller } = fixture();
    await controller.start();
    audio.configurationCapabilities.mockRejectedValueOnce(
      new Error("probe failed"),
    );
    await controller.apply(requestFor("new"));
    expect(
      controller.getSnapshot().configurationCapabilities.sampleRates,
    ).toEqual([]);
    audio.configurationCapabilities.mockResolvedValue({
      ...configuration,
      sampleRates: [44100],
    });
    await controller.refresh();
    expect(
      controller.getSnapshot().configurationCapabilities.sampleRates,
    ).toEqual([44100]);
    expect(audio.configurationCapabilities).toHaveBeenLastCalledWith(
      requestFor("new"),
    );
  });

  it("persists the last successful request when a newer queued request fails", async () => {
    const { audio, controller, onAccepted } = fixture();
    await controller.start();
    const first = deferred<RuntimeAudioConfiguration>();
    const last = deferred<RuntimeAudioConfiguration>();
    audio.applyConfiguration
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => last.promise);
    const applyFirst = controller.apply(requestFor("first"));
    const applyLast = controller.apply(requestFor("last"));
    first.resolve({ ...runtime, calibrationContext: "first" });
    await applyFirst;
    expect(controller.getSnapshot().requested.inputDeviceId).toBe("last");
    expect(onAccepted).not.toHaveBeenCalled();
    last.reject(new Error("driver busy"));
    await applyLast;
    expect(controller.getSnapshot().requested.inputDeviceId).toBe("first");
    expect(controller.getSnapshot().runtime.calibrationContext).toBe("first");
    expect(controller.getSnapshot().applying).toBe(false);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(requestFor("first"));
  });

  it("releases the old driver before probing the accepted configuration", async () => {
    const { audio, controller } = fixture();
    await controller.start();
    const calls: string[] = [];
    audio.applyConfiguration.mockImplementation(async () => {
      calls.push("apply");
      return runtime;
    });
    audio.configurationCapabilities.mockImplementation(async () => {
      calls.push("probe");
      return configuration;
    });
    await controller.apply(requestFor("new"));
    expect(calls).toEqual(["apply", "probe"]);
  });

  it("uses the current runtime on rollback instead of a previous apply result", async () => {
    const { audio, controller } = fixture();
    await controller.start();
    await controller.apply(requestFor("earlier"));
    const currentRuntime = {
      ...runtime,
      backend: "WASAPI Exclusive" as const,
      calibrationContext: "external-change",
    };
    audio.runtimeConfiguration.mockResolvedValue(currentRuntime);
    await controller.refresh();
    audio.applyConfiguration.mockRejectedValueOnce(new Error("switch failed"));
    await controller.apply(requestFor("broken"));
    expect(controller.getSnapshot().runtime).toEqual(currentRuntime);
  });

  it("reports the latest committed operation failing after its tab closes", async () => {
    const { audio, controller, onChange, onError } = fixture();
    await controller.start();
    const operation = deferred<RuntimeAudioConfiguration>();
    audio.applyConfiguration.mockImplementationOnce(() => operation.promise);
    const apply = controller.apply(requestFor("broken"));
    controller.stop();
    onChange.mockClear();
    const error = new Error("driver rejected the change");
    operation.reject(error);
    await apply;
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves a newer unavailable-ASIO selection while saving an earlier successful switch", async () => {
    const { audio, controller, onAccepted } = fixture();
    await controller.start();
    const operation = deferred<RuntimeAudioConfiguration>();
    audio.applyConfiguration.mockImplementationOnce(() => operation.promise);
    const apply = controller.apply(requestFor("working"));
    controller.selectUnavailableAsio(requestFor("missing"));
    operation.resolve(runtime);
    await apply;
    expect(controller.getSnapshot().requested.inputDeviceId).toBe("missing");
    expect(controller.getSnapshot().asioUnavailable).toBe(true);
    expect(controller.getSnapshot().applying).toBe(false);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(requestFor("working"));
  });

  it("ignores a poll response started before a newer user request", async () => {
    const { audio, controller, onChange } = fixture();
    await controller.start();
    const read = deferred<RuntimeAudioConfiguration>();
    audio.runtimeConfiguration.mockImplementationOnce(() => read.promise);
    const refresh = controller.refresh();
    await Promise.resolve();
    const apply = controller.apply(requestFor("new"));
    onChange.mockClear();
    read.resolve({ ...runtime, backend: "WASAPI Shared" });
    await refresh;
    await apply;
    expect(
      onChange.mock.calls.every(
        ([state]) => state.requested.inputDeviceId === "new",
      ),
    ).toBe(true);
    expect(controller.getSnapshot().requested.inputDeviceId).toBe("new");
  });

  it("does not publish a pending read or schedule polling after stop", async () => {
    const { audio, controller, onChange } = fixture();
    const read = deferred<RuntimeAudioConfiguration>();
    audio.runtimeConfiguration.mockImplementationOnce(() => read.promise);
    const start = controller.start();
    await Promise.resolve();
    controller.stop();
    onChange.mockClear();
    read.resolve(runtime);
    await start;
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh read immediately after stop/start while an old read is pending", async () => {
    const { audio, controller } = fixture();
    const stale = deferred<RuntimeAudioConfiguration>();
    audio.runtimeConfiguration.mockImplementationOnce(() => stale.promise);
    const earlier = controller.start();
    controller.stop();
    await controller.start();
    expect(audio.runtimeConfiguration).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().ready).toBe(true);
    stale.resolve({ ...runtime, backend: "WASAPI Shared" });
    await earlier;
    expect(controller.getSnapshot().runtime.backend).toBe("ASIO");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not let a hanging status read from a closed tab block the reopened session", async () => {
    const { audio, controller } = fixture();
    audio.runtimeConfiguration.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    void controller.start();
    controller.stop();
    const next = audioSessionFor(
      audio as unknown as SettingsAudioPort,
      initial,
    );
    expect(next.getSnapshot).toBe(controller.getSnapshot);
    controllers.push(next);
    await next.start();
    expect(next.getSnapshot().ready).toBe(true);
    expect(audio.runtimeConfiguration).toHaveBeenCalledTimes(2);
  });

  it("serializes changes across a tab remount and saves the accepted request after rollback", async () => {
    const {
      audio,
      controller: first,
      onChange,
      onAccepted,
      unsubscribe,
    } = fixture();
    await first.start();
    const pending = deferred<RuntimeAudioConfiguration>();
    audio.applyConfiguration
      .mockImplementationOnce(() => pending.promise)
      .mockRejectedValueOnce(new Error("new request failed"));
    const earlier = first.apply(requestFor("first"));
    first.stop();
    unsubscribe();
    onChange.mockClear();
    const saved = vi.fn();
    const second = audioSessionFor(
      audio as unknown as SettingsAudioPort,
      initial,
    );
    controllers.push(second);
    const start = second.start();
    const later = second.apply(requestFor("last"), {
      onAccepted: saved,
      onError: vi.fn(),
    });
    pending.resolve({ ...runtime, calibrationContext: "first" });
    await Promise.all([earlier, start, later]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledExactlyOnceWith(requestFor("first"));
    expect(second.getSnapshot().requested.inputDeviceId).toBe("first");
  });

  it("prepares an installed ASIO driver for restart without opening it", async () => {
    const { audio, controller, onAccepted } = fixture();
    await controller.start();
    audio.configurationCapabilities.mockClear();
    const driver = {
      id: "installed",
      name: "ASIO4ALL",
      backend: "ASIO",
      kind: "output",
      channels: 2,
    } as const;
    await controller.prepareAsio(requestFor(driver.id), driver);
    expect(audio.setPreferredConfiguration).toHaveBeenCalledWith(
      requestFor(driver.id),
    );
    expect(audio.applyConfiguration).not.toHaveBeenCalled();
    expect(controller.getSnapshot().asioReadyToRestart).toBe(true);
    expect(controller.getSnapshot().devices).toContainEqual(driver);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(requestFor(driver.id));
    await controller.refresh();
    expect(audio.configurationCapabilities).not.toHaveBeenCalled();
  });
});
