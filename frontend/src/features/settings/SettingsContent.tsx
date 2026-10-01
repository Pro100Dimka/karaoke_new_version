import type { FormikProps } from "formik";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
  SettingsTab,
} from "../../contracts/models";
import type { AudioValues } from "./tabs/Audio/settingsModel";
import { AdvancedSettings } from "./tabs/Advanced";
import { AiSettings } from "./tabs/Ai";
import { AppearanceSettings } from "./tabs/Appearance";
import { AudioSettings } from "./tabs/Audio";
import { SecretsSettings } from "./tabs/Secrets";

export const SettingsContent = ({
  tab,
  formik,
  runtime,
  devices,
  capabilities,
  configurationCapabilities,
  audioAvailable,
  inputLevel,
  testingInput,
  onToggleInputTest,
  onPlayTestSound,
  onAudioCommit,
  asioUnavailable,
  asioReadyToRestart,
  onAsioDriverDetected,
  onOpenAsioControlPanel,
  releaseAsioInBackground,
  onReleaseAsioInBackgroundChange,
}: {
  tab: SettingsTab;
  formik: FormikProps<AudioValues>;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  configurationCapabilities: AudioConfigurationCapabilities;
  audioAvailable: boolean;
  inputLevel: number;
  testingInput: boolean;
  onToggleInputTest(enabled: boolean): void;
  onPlayTestSound(): void;
  onAudioCommit(name: string, value: unknown): void;
  asioUnavailable: boolean;
  asioReadyToRestart: boolean;
  onAsioDriverDetected(device: DeviceDto): void;
  onOpenAsioControlPanel(): void;
  releaseAsioInBackground: boolean;
  onReleaseAsioInBackgroundChange(value: boolean): void;
}) => {
  if (tab === "appearance") return <AppearanceSettings />;

  if (tab === "audio") {
    return (
      <AudioSettings
        formik={formik}
        runtime={runtime}
        devices={devices}
        capabilities={capabilities}
        configurationCapabilities={configurationCapabilities}
        audioAvailable={audioAvailable}
        inputLevel={inputLevel}
        testingInput={testingInput}
        onToggleInputTest={onToggleInputTest}
        onPlayTestSound={onPlayTestSound}
        onAudioCommit={onAudioCommit}
        asioUnavailable={asioUnavailable}
        asioReadyToRestart={asioReadyToRestart}
        onAsioDriverDetected={onAsioDriverDetected}
        onOpenAsioControlPanel={onOpenAsioControlPanel}
        releaseAsioInBackground={releaseAsioInBackground}
        onReleaseAsioInBackgroundChange={onReleaseAsioInBackgroundChange}
      />
    );
  }

  if (tab === "ai") return <AiSettings />;
  if (tab === "environment") return <SecretsSettings />;
  return <AdvancedSettings />;
};
