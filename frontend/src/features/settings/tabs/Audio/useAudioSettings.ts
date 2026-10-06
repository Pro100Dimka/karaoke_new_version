import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import type { FormApi } from "@ad-voice/ui";
import { useApp } from "../../../../app/AppContext";
import { useNotify } from "../../../../app/NotificationsProvider";
import type {
  AudioBackendName,
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { audioClient } from "../../../../services/audioClient";
import type { SettingsFormValues } from "../../settingsForm";
import type { AudioSettingsProps } from ".";
import {
  toAudioRequest,
  toAudioValues,
  type AudioValues,
} from "./settingsModel";
import { useAudioTests } from "./useAudioTests";

const timing = { sampleRate: 0, periodFrames: 0, inputPeriodFrames: 0,
  bufferFrames: 0 } as const;

const emptyRuntime: RuntimeAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 0,
  periodFrames: 0,
  endpointBufferFrames: 0,
  estimatedLatencyMs: null,
};

type UiState = {
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  configurationCapabilities: AudioConfigurationCapabilities;
  configurationCapabilitiesBackend: AudioBackendName;
  audioAvailable: boolean;
  asioUnavailable: boolean;
  asioReadyToRestart: boolean;
  ready: boolean;
};

const initialUi: UiState = {
  runtime: emptyRuntime,
  devices: [],
  capabilities: {
    microphone: "missing",
    keyboardLighting: false,
  },
  configurationCapabilities: {
    sampleRates: [],
    periodFrames: [],
    defaultSampleRate: 0,
    defaultPeriodFrames: 0,
  },
  configurationCapabilitiesBackend: "WASAPI Shared",
  audioAvailable: false,
  asioUnavailable: false,
  asioReadyToRestart: false,
  ready: false,
};

type Fn = (...args: never[]) => unknown;
const optional = <T>(promise: Promise<T>) => promise.catch(() => null);
const later = (fn: () => void) => window.setTimeout(fn, 1000);

const useEvent = <T extends Fn>(fn: T): T => {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback(
    ((...args: Parameters<T>) => ref.current(...args)) as T,
    [],
  );
};

const patchFor = (
  name: keyof AudioValues,
  value: AudioValues[keyof AudioValues],
  current: AudioValues,
): Partial<AudioValues> => {
  if (name === "backend")
    return {
      ...timing,
      ...((current.backend === "ASIO") !== (value === "ASIO") && {
        inputDeviceId: "",
        outputDeviceId: "",
      }),
    };
  if (name === "inputDeviceId" || name === "outputDeviceId")
    return {
      ...timing,
      ...(current.backend === "ASIO" && {
        inputDeviceId: String(value),
        outputDeviceId: String(value),
      }),
    };
  return {};
};

const runtimePatch = (
  runtime: RuntimeAudioConfiguration,
  backend: AudioValues["backend"],
): Partial<AudioValues> => ({
  sampleRate: runtime.sampleRate,
  [backend === "WASAPI Shared" ? "periodFrames" : "bufferFrames"]:
    backend === "WASAPI Shared"
      ? (runtime.selectedPeriodFrames || runtime.periodFrames)
      : runtime.periodFrames,
});

export const useAudioSettings = (form: FormApi<SettingsFormValues>) => {
  const { preferences, updatePreferences } = useApp("preferences");
  const t = useText();
  const notify = useNotify();
  const flow = useRef({
    queue: Promise.resolve<void>(undefined),
    busy: false,
    accepted: preferences.audio,
    runtime: initialUi.runtime,
  });
  const { values } = form;
  const [ui, patchUi] = useReducer(
    (state: UiState, patch: Partial<UiState>) => {
      const runtime = patch.runtime;
      if (runtime && Object.keys(runtime).length === Object.keys(state.runtime).length &&
        Object.entries(runtime).every(([key, value]) =>
          Object.is(state.runtime[key as keyof RuntimeAudioConfiguration], value))) {
        patch = { ...patch, runtime: state.runtime };
      }
      return Object.entries(patch).every(([key, value]) =>
        Object.is(state[key as keyof UiState], value)) ? state : { ...state, ...patch };
    },
    initialUi,
  );

  const { devices, asioUnavailable } = ui;

  const syncForm = useEvent((patch: Partial<AudioValues>) =>
    Object.entries(patch).forEach(
      ([name, value]) =>
        !Object.is(values[name as keyof AudioValues], value) &&
        form.setValue(name, value),
    ),
  );

  const receiveRuntime = useEvent(
    (next: RuntimeAudioConfiguration, blocked = asioUnavailable) => {
      const state = flow.current;
      const capabilitiesChanged =
        next.backend !== state.runtime.backend ||
        next.calibrationContext !== state.runtime.calibrationContext;
      state.runtime = next;
      patchUi({ runtime: next });
      if (!state.busy && !blocked && next.backend !== state.accepted.backend) {
        state.accepted = { ...state.accepted, backend: next.backend };
        const nextValues = toAudioValues(state.accepted);
        Object.assign(nextValues, runtimePatch(next, nextValues.backend));
        syncForm(nextValues);
      } else if (next.backend === values.backend) {
        syncForm(runtimePatch(next, values.backend));
      }

      return capabilitiesChanged;
    },
  );

  const { inputLevel, testingInput, setTestingInput, playTestSound } =
    useAudioTests(true, receiveRuntime);

  const reportError = useEvent((error: unknown) =>
    notify(
      `${t("settingsApplyFailed")}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    ),
  );

  useEffect(() => {
    flow.current.accepted = preferences.audio;
  }, [preferences.audio]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const requested = flow.current.accepted;

    patchUi({ ready: false });

    const poll = async () => {
      const state = flow.current;
      const queue = state.queue;
      const stable = () => alive && !state.busy && state.queue === queue;

      try {
        if (state.busy) return;

        const next = await audioClient.runtimeConfiguration();
        if (!stable() || !receiveRuntime(next)) return;

        const capabilityRequest = state.accepted.backend === "ASIO" &&
          (state.accepted.inputDeviceId || state.accepted.outputDeviceId)
          ? state.accepted
          : { ...state.accepted, backend: next.backend };
        const nextCapabilities = await audioClient.configurationCapabilities(capabilityRequest);

        if (stable()) {
          patchUi({ configurationCapabilities: nextCapabilities,
            configurationCapabilitiesBackend: capabilityRequest.backend });
        }
      } catch {
        // Retry next tick.
      } finally {
        if (alive) timer = later(() => void poll());
      }
    };

    void (async () => {
      const [nextRuntime, nextDevices, nextCapabilities] = await Promise.all([
        optional(audioClient.runtimeConfiguration()),
        optional(audioClient.listDevices()),
        optional(audioClient.capabilities()),
      ]);

      if (!alive) return;

      const capabilityRequest = requested.backend === "ASIO" &&
        (requested.inputDeviceId || requested.outputDeviceId)
        ? requested
        : nextRuntime ? { ...requested, backend: nextRuntime.backend } : requested;
      const nextConfigurationCapabilities = await optional(
        audioClient.configurationCapabilities(capabilityRequest),
      );

      if (!alive) return;

      const nextAsioUnavailable =
        requested.backend === "ASIO" &&
        (!nextRuntime ||
          nextRuntime.backend !== "ASIO" ||
          !nextConfigurationCapabilities);

      patchUi({
        devices: nextDevices ?? [],
        capabilities: nextCapabilities ?? initialUi.capabilities,
        configurationCapabilities:
          nextConfigurationCapabilities ?? initialUi.configurationCapabilities,
        configurationCapabilitiesBackend: capabilityRequest.backend,
        audioAvailable: Boolean(nextRuntime && nextDevices),
        asioUnavailable: nextAsioUnavailable,
        ready: true,
      });

      if (nextRuntime) receiveRuntime(nextRuntime, nextAsioUnavailable);
      timer = later(() => void poll());
    })();

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [receiveRuntime]);

  const applyAudio = useEvent((request: RequestedAudioConfiguration) => {
    const state = flow.current;
    state.busy = true;

    let current!: Promise<void>;

    const run = async () => {
      const selectedAsio = request.backend === "ASIO" &&
        (request.inputDeviceId || request.outputDeviceId);
      try {
        if (selectedAsio) {
          const capabilities = await optional(audioClient.configurationCapabilities(request));
          if (capabilities) patchUi({ configurationCapabilities: capabilities,
            configurationCapabilitiesBackend: "ASIO" });
        }
        const nextRuntime = await audioClient.applyConfiguration(request);

        state.accepted = request;
        receiveRuntime(nextRuntime);
        patchUi({ asioUnavailable: false });
        updatePreferences({ audio: request });
      } catch (error) {
        if (request.backend === "ASIO") {
          patchUi({ asioUnavailable: true });
        } else {
          syncForm(toAudioValues(state.accepted));
          reportError(error);
        }
      } finally {
        if (state.queue !== current) return;

        if (!selectedAsio) {
          const nextCapabilities = await optional(
            audioClient.configurationCapabilities(state.accepted),
          );

          if (state.queue === current && nextCapabilities) {
            patchUi({ configurationCapabilities: nextCapabilities,
              configurationCapabilitiesBackend: state.accepted.backend });
          }
        }
      }
    };

    current = state.queue.then(run, run);
    state.queue = current;

    void current.finally(() => {
      if (state.queue === current) state.busy = false;
    });
  });

  const handleAudioCommit = useEvent(
    <K extends keyof AudioValues>(name: K, value: AudioValues[K]) => {
      const patch = patchFor(name, value, values);
      syncForm(patch);

      const request = toAudioRequest({
        ...values,
        [name]: value,
        ...patch,
      } as AudioValues);

      if (
        request.backend === "ASIO" &&
        !devices.some(({ backend }) => backend === "ASIO")
      ) {
        patchUi({ asioUnavailable: true });
        return;
      }

      applyAudio(request);
    },
  );

  const handleAsioDriverDetected = useEvent((driver: DeviceDto) => {
    const request: RequestedAudioConfiguration = {
      backend: "ASIO",
      inputDeviceId: driver.id,
      outputDeviceId: driver.id,
      ...timing,
    };

    flow.current.accepted = request;
    audioClient.setPreferredConfiguration(request);
    updatePreferences({ audio: request });
    syncForm(toAudioValues(request));

    patchUi({
      asioReadyToRestart: true,
      devices: devices.some(
        ({ id, backend }) => id === driver.id && backend === "ASIO",
      )
        ? devices
        : [...devices, driver],
    });
  });

  return {
    ready: ui.ready,
    audio: {
      ...ui,
      form,
      inputLevel,
      testingInput,
      onToggleInputTest: setTestingInput,
      onPlayTestSound: () => void playTestSound(),
      onAsioDriverDetected: handleAsioDriverDetected,
      onOpenAsioControlPanel: () =>
        void audioClient
          .openBackendControlPanel(toAudioRequest(values))
          .catch(reportError),
      releaseAsioInBackground: values.releaseAsioInBackground,
      onReleaseAsioInBackgroundChange: (releaseAsioInBackground) =>
        form.setValue("releaseAsioInBackground", releaseAsioInBackground),
      onAudioCommit: handleAudioCommit,
    } satisfies AudioSettingsProps<SettingsFormValues>,
  };
};
