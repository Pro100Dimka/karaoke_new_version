import { Cpu, Palette, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import type {
  AudioCapabilities,
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
import { toAudioRequest, toAudioValues, type AudioValues } from "./settingsModel";
import { useAudioTests } from "./useAudioTests";

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
  { value: "advanced", label: "advanced", icon: Wrench }
] as const satisfies readonly SettingsTabDefinition[];

const emptyRuntime: RuntimeAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 48000,
  periodFrames: 256,
  endpointBufferFrames: 0,
  estimatedLatencyMs: 0
};
const unknownCapabilities: AudioCapabilities = { microphone: "missing", keyboardLighting: false };

/** Every setting takes effect the moment it changes; there is nothing to apply, cancel or reset at the bottom. */
export const SettingsModal = () => {
  const { settingsOpen, settingsTab, setSettingsOpen, preferences, updatePreferences } = useApp();
  const t = useText();
  const notify = useNotify();
  const loadGeneration = useRef(0);
  const applyQueue = useRef<Promise<void>>(Promise.resolve());

  const [tab, setTab] = useState<SettingsTab>("appearance");
  const [runtime, setRuntime] = useState<RuntimeAudioConfiguration>(emptyRuntime);
  const [devices, setDevices] = useState<readonly DeviceDto[]>([]);
  const [capabilities, setCapabilities] = useState<AudioCapabilities>(unknownCapabilities);
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
    // AudioService being down must not make the whole Settings surface unusable.
    setAudioAvailable(runtimeResult.status === "fulfilled" && deviceResult.status === "fulfilled");
    if (runtimeResult.status === "fulfilled") setRuntime(runtimeResult.value);
    setDevices(deviceResult.status === "fulfilled" ? deviceResult.value : []);
    setCapabilities(capabilityResult.status === "fulfilled" ? capabilityResult.value : unknownCapabilities);
    setLoadState("ready");
  }, []);

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

  /** The choice is stored at once, even if AudioService cannot apply it right now; applies run one after another. */
  const applyAudio = useCallback(
    (request: RequestedAudioConfiguration) => {
      updatePreferences({ audio: request });
      applyQueue.current = applyQueue.current.then(async () => {
        try {
          setRuntime(await audioClient.applyConfiguration(request));
        } catch (error) {
          notify(`${t("settingsApplyFailed")}: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      });
    },
    [notify, t, updatePreferences]
  );

  const initialAudio = useMemo(() => toAudioValues(preferences.audio), [preferences.audio]);
  const formik = useGetForm<AudioValues>({ initialValues: initialAudio, onSubmit: () => undefined });
  const { values } = formik;

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
                audioAvailable={audioAvailable}
                inputLevel={inputLevel}
                testingInput={testingInput}
                onToggleInputTest={setTestingInput}
                onPlayTestSound={() => void playTestSound()}
                onAudioCommit={(name, value) => applyAudio(toAudioRequest({ ...values, [name]: value }))}
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
