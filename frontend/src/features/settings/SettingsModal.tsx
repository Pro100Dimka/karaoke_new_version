import {
  AnimatedBorder,
  BrandMark,
  Dialog,
  Planet,
  useForm,
} from "@ad-voice/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useApp, useSettingsDialog } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
  SettingsTab,
} from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { SettingsAtmosphere } from "./Atmosphere";
import "./settings.css";
import { AdvancedSettings } from "./tabs/Advanced";
import { AiSettings } from "./tabs/Ai";
import { AppearanceSettings } from "./tabs/Appearance";
import { AudioSettings, type AudioSettingsProps } from "./tabs/Audio";
import {
  toAudioRequest,
  toAudioValues,
  type AudioValues,
} from "./tabs/Audio/settingsModel";
import { useAudioTests } from "./tabs/Audio/useAudioTests";
import { SecretsSettings } from "./tabs/Secrets";

const timing = { sampleRate: 0, periodFrames: 0, bufferFrames: 0 } as const;

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
  audioAvailable: boolean;
  asioUnavailable: boolean;
  asioReadyToRestart: boolean;
  ready: boolean;
};

const initialUi: UiState = {
  runtime: emptyRuntime,
  devices: [] as readonly DeviceDto[],
  capabilities: {
    microphone: "missing",
    keyboardLighting: false,
  },
  configurationCapabilities: {
    sampleRates: [] as number[],
    periodFrames: [] as number[],
    defaultSampleRate: 0,
    defaultPeriodFrames: 0,
  },
  audioAvailable: false,
  asioUnavailable: false,
  asioReadyToRestart: false,
  ready: false,
};

type Fn = (...args: never[]) => unknown;
type AudioValue = AudioValues[keyof AudioValues];
type Entry<T extends object> = {
  [K in keyof T]-?: [K, T[K]];
}[keyof T];
type Rule = (
  value: AudioValue,
  current: AudioValues,
) => (Partial<AudioValues> | false)[];
type TabSpec = {
  label: MessageKey;
  icon: string;
  render: (audio: AudioSettingsProps) => ReactNode;
};

const entries = Object.entries as <T extends object>(value: T) => Entry<T>[];
const optional = <T,>(promise: Promise<T>) => promise.catch(() => null);
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

const tabConfig: Record<SettingsTab, TabSpec> = {
  appearance: {
    label: "appearance",
    icon: "palette",
    render: () => <AppearanceSettings />,
  },
  audio: {
    label: "audio",
    icon: "volume",
    render: (audio) => <AudioSettings {...audio} />,
  },
  ai: {
    label: "aiProcessing",
    icon: "chip",
    render: () => <AiSettings />,
  },
  environment: {
    label: "environmentKeys",
    icon: "key",
    render: () => <SecretsSettings />,
  },
  advanced: {
    label: "advanced",
    icon: "wrench",
    render: () => <AdvancedSettings />,
  },
};

const deviceRule: Rule = (value, current) => [
  timing,
  current.backend === "ASIO" && {
    inputDeviceId: String(value),
    outputDeviceId: String(value),
  },
];

const rules: Partial<Record<keyof AudioValues, Rule>> = {
  backend: (value, current) => [
    timing,
    (current.backend === "ASIO") !== (value === "ASIO") && {
      inputDeviceId: "",
      outputDeviceId: "",
    },
  ],
  inputDeviceId: deviceRule,
  outputDeviceId: deviceRule,
};

const patchFor = (
  name: keyof AudioValues,
  value: AudioValue,
  current: AudioValues,
) =>
  Object.assign(
    {},
    ...(rules[name]?.(value, current).filter(Boolean) ?? []),
  ) as Partial<AudioValues>;

const runtimePatch = (
  runtime: RuntimeAudioConfiguration,
  backend: AudioValues["backend"],
): Partial<AudioValues> => ({
  sampleRate: runtime.sampleRate,
  [backend === "WASAPI Shared" ? "periodFrames" : "bufferFrames"]:
    runtime.periodFrames,
});

export const SettingsModal = () => {
  const { preferences, updatePreferences } = useApp();
  const { settingsOpen, settingsTab, setSettingsOpen } = useSettingsDialog();
  const t = useText();
  const notify = useNotify();

  const flow = useRef({
    queue: Promise.resolve<void>(undefined),
    busy: false,
    accepted: preferences.audio,
    runtime: initialUi.runtime,
  });

  const form = useForm<AudioValues>({
    initialValues: useMemo(
      () => toAudioValues(preferences.audio),
      [preferences.audio],
    ),
  });
  const { values, reset } = form;

  const [tab, setTab] = useState<SettingsTab>(settingsTab);
  const [ui, patchUi] = useReducer(
    (state: UiState, patch: Partial<UiState>) => ({ ...state, ...patch }),
    initialUi,
  );

  const {
    ready,
    runtime,
    devices,
    capabilities,
    configurationCapabilities,
    audioAvailable,
    asioUnavailable,
    asioReadyToRestart,
  } = ui;

  const syncForm = (patch: Partial<AudioValues>) =>
    entries(patch).forEach(
      ([name, value]) =>
        !Object.is(values[name], value) && form.setValue(name, value),
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
        reset(nextValues);
      } else {
        syncForm(runtimePatch(next, values.backend));
      }

      return capabilitiesChanged;
    },
  );

  const { inputLevel, testingInput, setTestingInput, playTestSound } =
    useAudioTests(settingsOpen, receiveRuntime);

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
    if (settingsOpen) setTab(settingsTab);
  }, [settingsOpen, settingsTab]);

  useEffect(() => {
    if (!settingsOpen) return;

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

        const nextCapabilities = await audioClient.configurationCapabilities({
          ...state.accepted,
          backend: next.backend,
        });

        if (stable()) {
          patchUi({ configurationCapabilities: nextCapabilities });
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

      const nextConfigurationCapabilities = await optional(
        audioClient.configurationCapabilities(
          nextRuntime
            ? { ...requested, backend: nextRuntime.backend }
            : requested,
        ),
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
  }, [settingsOpen, receiveRuntime]);

  const applyAudio = useEvent((request: RequestedAudioConfiguration) => {
    const state = flow.current;
    state.busy = true;

    let current!: Promise<void>;

    const run = async () => {
      try {
        const nextRuntime = await audioClient.applyConfiguration(request);

        state.accepted = request;
        receiveRuntime(nextRuntime);
        patchUi({ asioUnavailable: false });
        updatePreferences({ audio: request });
      } catch (error) {
        if (request.backend === "ASIO") {
          patchUi({ asioUnavailable: true });
        } else {
          reset(toAudioValues(state.accepted));
          reportError(error);
        }
      } finally {
        if (state.queue !== current) return;

        const nextCapabilities = await optional(
          audioClient.configurationCapabilities(state.accepted),
        );

        if (state.queue === current && nextCapabilities) {
          patchUi({ configurationCapabilities: nextCapabilities });
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
    reset(toAudioValues(request));

    patchUi({
      asioReadyToRestart: true,
      devices: devices.some(
        ({ id, backend }) => id === driver.id && backend === "ASIO",
      )
        ? devices
        : [...devices, driver],
    });
  });

  const close = useEvent(() => {
    setTestingInput(false);
    patchUi({ ready: false, asioReadyToRestart: false });
    setSettingsOpen(false);
  });

  const audioProps: AudioSettingsProps = {
    form,
    runtime,
    devices,
    capabilities,
    configurationCapabilities,
    audioAvailable,
    inputLevel,
    testingInput,
    onToggleInputTest: setTestingInput,
    onPlayTestSound: () => void playTestSound(),
    asioUnavailable,
    asioReadyToRestart,
    onAsioDriverDetected: handleAsioDriverDetected,
    onOpenAsioControlPanel: () =>
      void audioClient
        .openBackendControlPanel(toAudioRequest(values))
        .catch(reportError),
    releaseAsioInBackground: preferences.releaseAsioInBackground,
    onReleaseAsioInBackgroundChange: (releaseAsioInBackground) =>
      updatePreferences({ releaseAsioInBackground }),
    onAudioCommit: handleAudioCommit,
  };

  const tabItems = useMemo(
    () =>
      entries(tabConfig).map(([value, { label, icon }]) => ({
        value,
        label: t(label),
        icon,
      })),
    [t],
  );

  if (!settingsOpen) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      className="settingsDialog"
      width="full"
      icon="settings"
      title={t("settings")}
      description={t("settingsDescription")}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={false}
      art={
        <>
          <SettingsAtmosphere />
          <Planet className="settingsHeaderArt" />
          <AnimatedBorder shell className="settingsFrame" />
          <BrandMark className="settingsSignature" />
        </>
      }
    >
      {/* {!ready ? (
        <ProgressBar
          className="settingsLoading"
          indeterminate
          label={t("loadingSettings")}
        />
      ) : (
        <Stack gap={1}>
          <Tabs
            className="settingsNav"
            value={tab}
            onValueChange={setTab}
            items={tabItems}
          />
          <div className="settingsBody">
            {tabConfig[tab].render(audioProps)}
          </div>
        </Stack>
      )} */}
    </Dialog>
  );
};

export default SettingsModal;
