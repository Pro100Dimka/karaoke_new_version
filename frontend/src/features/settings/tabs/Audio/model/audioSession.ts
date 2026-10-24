import type { SettingsAudioPort } from "../../../../../application/settings/SettingsPorts";
import type {
  AudioBackendName,
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from "../../../../../contracts/models";

const emptyCapabilities: AudioConfigurationCapabilities = {
  sampleRates: [],
  periodFrames: [],
  defaultSampleRate: 0,
  defaultPeriodFrames: 0,
};
const defaultRequest: RequestedAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 0,
  periodFrames: 0,
};
export type AudioSnapshot = {
  requested: RequestedAudioConfiguration;
  accepted: RequestedAudioConfiguration;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  configurationCapabilities: AudioConfigurationCapabilities;
  configurationCapabilitiesBackend: AudioBackendName;
  audioAvailable: boolean;
  asioUnavailable: boolean;
  asioReadyToRestart: boolean;
  applying: boolean;
  ready: boolean;
};
export type AudioCommitEffects = {
  onAccepted(request: RequestedAudioConfiguration): void;
  onError(error: unknown): void;
};
const noEffects: AudioCommitEffects = {
  onAccepted: () => undefined,
  onError: () => undefined,
};
const sameRequest = (
  a: RequestedAudioConfiguration,
  b: RequestedAudioConfiguration,
) =>
  [...Object.keys(a), ...Object.keys(b)].every((key) =>
    Object.is(a[key as keyof typeof a], b[key as keyof typeof b]),
  );

/** One snapshot and one hardware queue survive the views that subscribe to them. */
export const createAudioSession = (
  audio: SettingsAudioPort,
  initial = defaultRequest,
) => {
  let state: AudioSnapshot = {
    requested: initial,
    accepted: initial,
    runtime: {
      backend: "WASAPI Shared",
      sampleRate: 0,
      periodFrames: 0,
      endpointBufferFrames: 0,
      estimatedLatencyMs: null,
    },
    devices: [],
    capabilities: { microphone: "missing", keyboardLighting: false },
    configurationCapabilities: emptyCapabilities,
    configurationCapabilitiesBackend: initial.backend,
    audioAvailable: false,
    asioUnavailable: false,
    asioReadyToRestart: false,
    applying: false,
    ready: false,
  };
  const listeners = new Set<() => void>();
  let tail = Promise.resolve();
  let pending = 0;
  let revision = 0;
  let needsPersistence = false;
  let views = 0;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let refreshGeneration = 0;
  let devicesKnown = false;
  let devicesDirty = true;
  let microphoneDirty = true;
  let configurationDirty = true;
  let nextDeviceRefresh = 0;

  const publish = (patch: Partial<AudioSnapshot> = {}) => {
    state = { ...state, ...patch, applying: pending > 0 };
    if (views) listeners.forEach((listener) => listener());
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const current = (request: number, view: number) =>
    views > 0 && revision === request && generation === view;
  const refreshConfiguration = async (request: number, view: number) => {
    const selected = state.requested;
    const target =
      !state.audioAvailable ||
      (selected.backend === "ASIO" &&
        (selected.inputDeviceId || selected.outputDeviceId))
        ? selected
        : { ...selected, backend: state.runtime.backend };
    try {
      const capabilities = await audio.configurationCapabilities(target);
      if (!current(request, view)) return;
      configurationDirty = false;
      publish({
        configurationCapabilities: capabilities,
        configurationCapabilitiesBackend: target.backend,
        asioUnavailable:
          selected.backend === "ASIO" && state.runtime.backend !== "ASIO",
      });
    } catch {
      if (!current(request, view)) return;
      configurationDirty = true;
      publish({
        configurationCapabilities: emptyCapabilities,
        configurationCapabilitiesBackend: target.backend,
        asioUnavailable: selected.backend === "ASIO",
      });
    }
  };
  const refresh = (): Promise<void> => {
    if (!views) return Promise.resolve();
    if (refreshing && refreshGeneration === generation) return refreshing;
    clearTimeout(timer);
    const request = revision;
    const view = generation;
    refreshGeneration = view;
    // Passive reads never hold the hardware queue: an old hung read cannot block a new view.
    const operation = (async () => {
      if (!current(request, view) || pending) return;
      const readDevices = devicesDirty || Date.now() >= nextDeviceRefresh;
      const readMicrophone = microphoneDirty || readDevices;
      const [runtime, devices, capabilities] = await Promise.allSettled([
        audio.runtimeConfiguration(),
        readDevices ? audio.listDevices() : Promise.resolve(state.devices),
        readMicrophone
          ? audio.capabilities()
          : Promise.resolve(state.capabilities),
      ]);
      if (!current(request, view)) return;
      const patch: Partial<AudioSnapshot> = {};
      if (devices.status === "fulfilled") {
        configurationDirty ||=
          devices.value.length !== state.devices.length ||
          devices.value.some((device, index) => {
            const previous = state.devices[index];
            return (
              !previous ||
              device.id !== previous.id ||
              device.backend !== previous.backend ||
              device.kind !== previous.kind ||
              device.channels !== previous.channels
            );
          });
        devicesKnown = true;
        devicesDirty = false;
        patch.devices = devices.value;
        if (readDevices) nextDeviceRefresh = Date.now() + 5000;
      } else devicesDirty = true;
      if (capabilities.status === "fulfilled") {
        microphoneDirty = false;
        patch.capabilities = capabilities.value;
      } else microphoneDirty = true;
      if (runtime.status === "fulfilled") {
        const changed =
          runtime.value.backend !== state.runtime.backend ||
          runtime.value.calibrationContext !== state.runtime.calibrationContext;
        configurationDirty ||= changed || !state.audioAvailable;
        if (configurationDirty)
          patch.configurationCapabilities = emptyCapabilities;
        if (changed && !readDevices) devicesDirty = true;
        if (changed && !readMicrophone) microphoneDirty = true;
        patch.runtime = runtime.value;
        patch.audioAvailable = devicesKnown;
      } else {
        patch.audioAvailable = false;
        configurationDirty = true;
      }
      publish(patch);
      if (configurationDirty && !state.asioReadyToRestart)
        await enqueue(async () => {
          if (current(request, view) && !pending)
            await refreshConfiguration(request, view);
        });
      if (current(request, view) && !state.ready) publish({ ready: true });
    })().finally(() => {
      if (refreshing !== operation) return;
      refreshing = undefined;
      if (views && generation === view)
        timer = setTimeout(() => void refresh(), 1000);
    });
    refreshing = operation;
    return operation;
  };
  const commit = (
    request: RequestedAudioConfiguration,
    effects: AudioCommitEffects,
    driver?: DeviceDto,
  ) => {
    const id = ++revision;
    pending++;
    configurationDirty = true;
    publish({
      requested: request,
      asioReadyToRestart: false,
      configurationCapabilities: emptyCapabilities,
      configurationCapabilitiesBackend: request.backend,
    });
    return enqueue(async () => {
      let prepared = false;
      try {
        if (driver) {
          await audio.setPreferredConfiguration(request);
          prepared = true;
          publish({ accepted: request });
        } else {
          const runtime = await audio.applyConfiguration(request);
          publish({ accepted: request, runtime });
        }
        needsPersistence = true;
      } catch (error) {
        if (revision === id) effects.onError(error);
      }
      try {
        if (revision !== id) return;
        publish({
          requested: state.accepted,
          asioReadyToRestart: prepared && request.backend === "ASIO",
          ...(prepared &&
            driver && {
              devices: state.devices.some(
                (item) => item.id === driver.id && item.backend === "ASIO",
              )
                ? state.devices
                : [...state.devices, driver],
            }),
        });
        devicesDirty = microphoneDirty = true;
        // The old driver has closed before a capability probe may open the accepted one.
        if (views && !prepared) await refreshConfiguration(id, generation);
      } finally {
        pending--;
        // If B fails after A succeeded, persist A once the queue reaches B's outcome.
        if (!pending && needsPersistence) {
          effects.onAccepted(state.accepted);
          needsPersistence = false;
        }
        publish();
      }
    });
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (++views === 1) {
        generation++;
        configurationDirty = devicesDirty = microphoneDirty = true;
        if (!pending) publish({ requested: state.accepted, ready: false });
      }
      return refresh();
    },
    stop: () => {
      if (views > 0 && --views === 0) {
        generation++;
        clearTimeout(timer);
      }
    },
    refresh,
    enqueue,
    apply: (request: RequestedAudioConfiguration, effects = noEffects) =>
      commit(request, effects),
    prepareAsio: (
      request: RequestedAudioConfiguration,
      driver: DeviceDto,
      effects = noEffects,
    ) => commit(request, effects, driver),
    selectUnavailableAsio: (request: RequestedAudioConfiguration) => {
      revision++;
      publish({ requested: request, asioUnavailable: true });
    },
    setSavedConfiguration: (request: RequestedAudioConfiguration) => {
      if (pending || sameRequest(request, state.accepted)) return;
      revision++;
      needsPersistence = false;
      configurationDirty = true;
      publish({ accepted: request, requested: request });
    },
  };
};

const sessions = new WeakMap<
  SettingsAudioPort,
  ReturnType<typeof createAudioSession>
>();
export const audioSessionFor = (
  audio: SettingsAudioPort,
  initial?: RequestedAudioConfiguration,
) => {
  let session = sessions.get(audio);
  if (!session) {
    session = createAudioSession(audio, initial);
    sessions.set(audio, session);
  }
  return session;
};
