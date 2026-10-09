import { ProgressBar, useFormContext } from "@ad-voice/ui";
import { useText } from "../../../i18n/useText";
import type { SettingsFormValues } from "../settingsForm";
import { AdvancedSettings } from "./Advanced";
import { AiSettings } from "./Ai";
import { AppearanceSettings } from "./Appearance";
import { AudioSettings } from "./Audio";
import { useAudioSettings } from "./Audio/useAudioSettings";
import { SecretsSettings } from "./Secrets";

const AudioTabContent = () => {
  const form = useFormContext<SettingsFormValues>();
  const t = useText();
  const { ready, audio } = useAudioSettings(form);
  return ready ? <AudioSettings {...audio} /> : (
    <ProgressBar className="settingsLoading" indeterminate label={t("loadingSettings")} />
  );
};

export default {
  appearance: {
    label: "appearance",
    icon: "palette",
    component: AppearanceSettings,
  },
  audio: { label: "audio", icon: "volume", component: AudioTabContent },
  ai: { label: "aiProcessing", icon: "chip", component: AiSettings },
  environment: {
    label: "environmentKeys",
    icon: "key",
    component: SecretsSettings,
  },
  advanced: { label: "advanced", icon: "wrench", component: AdvancedSettings },
} as const;
