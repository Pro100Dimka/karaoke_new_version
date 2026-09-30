import { Cpu, KeyRound, Palette, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
  SettingsTab
} from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { Modal } from "../../shared/ui/Modal";
import { Spinner } from "../../shared/ui/Spinner";
import { Tabs, useGetForm } from "../../theme/ui";
import "./settings.css";
import { SettingsContent } from "./SettingsContent";
import { toAudioRequest, toAudioValues, type AudioValues } from "./tabs/Audio/settingsModel";
import { useAudioTests } from "./tabs/Audio/useAudioTests";

type SettingsLoadState = "idle" | "loading" | "ready";

interface SettingsTabDefinition {
  value: SettingsTab;
  label: MessageKey;
  icon: LucideIcon;
}

const tabs = [
  { value: "appearance", label: "appearance", icon: Palette },
  { value: "audio", label: "audio", icon: SlidersHorizontal },
  { value: "ai", label: "aiProcessing", icon: Cpu },
  { value: "environment", label: "environmentKeys", icon: KeyRound },
  { value: "advanced", label: "advanced", icon: Wrench }
] as const satisfies readonly SettingsTabDefinition[];

const emptyRuntime: RuntimeAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 0,
  periodFrames: 0,
  endpointBufferFrames: 0,
  estimatedLatencyMs: null
};
const unknownCapabilities: AudioCapabilities = { microphone: "missing", keyboardLighting: false };
const unknownConfigurationCapabilities: AudioConfigurationCapabilities = {
  sampleRates: [], periodFrames: [], defaultSampleRate: 0, defaultPeriodFrames: 0
};

/** Every setting takes effect the moment it changes; there is nothing to apply, cancel or reset at the bottom. */
export const SettingsModal = () => {
  const { settingsOpen, settingsTab, setSettingsOpen, preferences, updatePreferences } = useApp();
  const t = useText();
  const notify = useNotify();
  const loadGeneration = useRef(0);
  const applyQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingAudioApplies = useRef(0);
  const applyEpoch = useRef(0);
  const acceptedAudio = useRef(preferences.audio);
  useEffect(() => { acceptedAudio.current = preferences.audio; }, [preferences.audio]);
  const initialAudio = useMemo(() => toAudioValues(preferences.audio), [preferences.audio]);
  const formik = useGetForm<AudioValues>({ initialValues: initialAudio, onSubmit: () => undefined });
  const { values, resetForm } = formik;
  const syncActiveBackend = useCallback((nextRuntime: RuntimeAudioConfiguration) => {
    if (pendingAudioApplies.current || nextRuntime.backend === acceptedAudio.current.backend) return;
    acceptedAudio.current = { ...acceptedAudio.current, backend: nextRuntime.backend };
    resetForm({ values: toAudioValues(acceptedAudio.current) });
  }, [resetForm]);

  const [tab, setTab] = useState<SettingsTab>("appearance");
  const [runtime, setRuntime] = useState<RuntimeAudioConfiguration>(emptyRuntime);
  const [devices, setDevices] = useState<readonly DeviceDto[]>([]);
  const [capabilities, setCapabilities] = useState<AudioCapabilities>(unknownCapabilities);
  const [configurationCapabilities, setConfigurationCapabilities] = useState<AudioConfigurationCapabilities>(unknownConfigurationCapabilities);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [loadState, setLoadState] = useState<SettingsLoadState>("idle");
  const { inputLevel, testingInput, setTestingInput, playTestSound } = useAudioTests(settingsOpen, setRuntime);

  const loadSettings = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoadState("loading");
    const [runtimeResult, deviceResult, capabilityResult] = await Promise.allSettled([
      audioClient.runtimeConfiguration(),
      audioClient.listDevices(),
      audioClient.capabilities()
    ]);
    if (generation !== loadGeneration.current) return;
    const activeRequest = runtimeResult.status === "fulfilled"
      ? { ...preferences.audio, backend: runtimeResult.value.backend }
      : preferences.audio;
    const activeConfigurationCapabilities = await audioClient.configurationCapabilities(activeRequest)
      .catch(() => unknownConfigurationCapabilities);
    if (generation !== loadGeneration.current) return;
    // AudioService being down must not make the whole Settings surface unusable.
    setAudioAvailable(runtimeResult.status === "fulfilled" && deviceResult.status === "fulfilled");
    if (runtimeResult.status === "fulfilled") {
      setRuntime(runtimeResult.value);
      // A saved request can differ from the backend that actually opened (for example after
      // a failed switch). Show the active backend without silently overwriting the request.
      syncActiveBackend(runtimeResult.value);
    }
    setDevices(deviceResult.status === "fulfilled" ? deviceResult.value : []);
    setCapabilities(capabilityResult.status === "fulfilled" ? capabilityResult.value : unknownCapabilities);
    setConfigurationCapabilities(activeConfigurationCapabilities);
    setLoadState("ready");
  }, [preferences.audio, syncActiveBackend]);

  useEffect(() => {
    if (settingsOpen) setTab(settingsTab);
  }, [settingsOpen, settingsTab]);

  useEffect(() => {
    if (!settingsOpen) return;
    void loadSettings();
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadSettings, settingsOpen]);

  // Core Audio notifies AudioService when the Windows default endpoint or its format changes.
  // Polling the lightweight authoritative snapshots keeps an already-open settings panel in sync
  // as well; the request itself gives AudioService an opportunity to process that notification.
  useEffect(() => {
    if (!settingsOpen) return;
    const refresh = async () => {
      const epoch = applyEpoch.current;
      const nextRuntime = await audioClient.runtimeConfiguration();
      if (epoch !== applyEpoch.current || pendingAudioApplies.current) return;
      const configurationChanged = nextRuntime.backend !== runtime.backend
        || nextRuntime.calibrationContext !== runtime.calibrationContext;
      setRuntime(nextRuntime);
      syncActiveBackend(nextRuntime);
      if (configurationChanged) {
        const nextCapabilities = await audioClient.configurationCapabilities(
          { ...acceptedAudio.current, backend: nextRuntime.backend });
        if (epoch === applyEpoch.current && !pendingAudioApplies.current)
          setConfigurationCapabilities(nextCapabilities);
      }
    };
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [runtime.backend, runtime.calibrationContext, settingsOpen, syncActiveBackend]);

  /** Driver changes run one after another and are persisted only after AudioService accepts them. */
  const applyAudio = useCallback(
    (request: RequestedAudioConfiguration) => {
      pendingAudioApplies.current += 1;
      applyEpoch.current += 1;
      applyQueue.current = applyQueue.current.then(async () => {
        try {
          const nextRuntime = await audioClient.applyConfiguration(request);
          setRuntime(nextRuntime);
          acceptedAudio.current = request;
          updatePreferences({ audio: request });
          // A capabilities refresh cannot undo a configuration already accepted by the service.
          setConfigurationCapabilities(await audioClient.configurationCapabilities(request)
            .catch(() => unknownConfigurationCapabilities));
        } catch (error) {
          resetForm({ values: toAudioValues(acceptedAudio.current) });
          notify(`${t("settingsApplyFailed")}: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          pendingAudioApplies.current -= 1;
          applyEpoch.current += 1;
        }
      });
    },
    [notify, t, updatePreferences, resetForm]
  );

  // Zero is only the internal first-run request meaning "query the endpoint". The selects expose
  // real device values only, so replace it (including values changed by Windows) with the runtime
  // format that AudioService actually opened.
  useEffect(() => {
    if (!settingsOpen || loadState !== "ready") return;
    if (values.sampleRate !== runtime.sampleRate)
      void formik.setFieldValue("sampleRate", runtime.sampleRate, false);
    if (values.backend === "WASAPI Shared") {
      if (values.periodFrames !== runtime.periodFrames)
        void formik.setFieldValue("periodFrames", runtime.periodFrames, false);
    } else if (values.bufferFrames !== runtime.periodFrames) {
      void formik.setFieldValue("bufferFrames", runtime.periodFrames, false);
    }
  }, [formik, loadState, runtime.periodFrames, runtime.sampleRate, settingsOpen, values.backend, values.bufferFrames, values.periodFrames, values.sampleRate]);

  const handleClose = () => {
    setTestingInput(false);
    setLoadState("idle");
    setSettingsOpen(false);
  };

  if (!settingsOpen) return null;

  const busy = loadState === "idle" || loadState === "loading";
  return (
    <Modal open title={t("settings")} closeLabel={t("closeDialog")} onClose={handleClose} className="settingsModal">
      {busy ? (
        <div className="settingsState" aria-live="polite">
          <Spinner label={t("loadingSettings")} />
        </div>
      ) : (
        <div className="settingsRoot">
          <div className="settingsLayout">
            <Tabs<SettingsTab>
              className="settingsNav"
              value={tab}
              onChange={setTab}
              items={tabs.map(item => {
                const Icon = item.icon;
                return { value: item.value, label: t(item.label), icon: <Icon size={16} /> };
              })}
            />
            <div className="settingsBody">
              <SettingsContent
                tab={tab}
                formik={formik}
                runtime={runtime}
                devices={devices}
                capabilities={capabilities}
                configurationCapabilities={configurationCapabilities}
                audioAvailable={audioAvailable}
                inputLevel={inputLevel}
                testingInput={testingInput}
                onToggleInputTest={setTestingInput}
                onPlayTestSound={() => void playTestSound()}
                onAudioCommit={(name, value) => {
                  const next = toAudioRequest({ ...values, [name]: value });
                  if (name === "backend" || name === "inputDeviceId" || name === "outputDeviceId") {
                    next.sampleRate = 0;
                    next.periodFrames = 0;
                    next.bufferFrames = 0;
                    void formik.setFieldValue("sampleRate", 0, false);
                    void formik.setFieldValue("periodFrames", 0, false);
                    void formik.setFieldValue("bufferFrames", 0, false);
                  }
                  applyAudio(next);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
