import type {
  AudioCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
  SettingsTab
} from "../../contracts/models";
import { AdvancedSettings } from "./AdvancedSettings";
import { AiSettings } from "./AiSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AudioSettings } from "./AudioSettings";
import type { FormikProps } from "formik";
import type { AudioValues } from "./settingsModel";


export const SettingsContent = ({
  tab,
  formik,
  runtime,
  devices,
  capabilities,
  audioAvailable,
  inputLevel,
  testingInput,
  onToggleInputTest,
  onPlayTestSound,
  onAudioCommit
}: {
  tab: SettingsTab;
  formik: FormikProps<AudioValues>;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  audioAvailable: boolean;
  inputLevel: number;
  testingInput: boolean;
  onToggleInputTest(enabled: boolean): void;
  onPlayTestSound(): void;
  onAudioCommit(name: string, value: unknown): void;
}) => {
  if (tab === "appearance") return <AppearanceSettings />;

  if (tab === "audio") {
    return (
      <AudioSettings
        formik={formik}
        runtime={runtime}
        devices={devices}
        capabilities={capabilities}
        audioAvailable={audioAvailable}
        inputLevel={inputLevel}
        testingInput={testingInput}
        onToggleInputTest={onToggleInputTest}
        onPlayTestSound={onPlayTestSound}
        onAudioCommit={onAudioCommit}
      />
    );
  }

  if (tab === "ai") return <AiSettings />;
  return <AdvancedSettings />;
};
