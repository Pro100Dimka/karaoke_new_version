import { ProgressBar } from "@neo-ui-kit/react";
import type { ComponentType } from "react";
import type { SettingsTab } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { AdvancedSettings } from "./Advanced";
import { AiSettings } from "./Ai";
import { AppearanceSettings } from "./Appearance";
import { AudioSettings } from "./Audio";
import { useAudioSettings } from "./Audio/hooks/useAudioSettings";
import { SecretsSettings } from "./Secrets";

const AudioTabContent = () => {
  const t = useText();
  const { ready, audio } = useAudioSettings();
  return ready ? (
    <AudioSettings {...audio} />
  ) : (
    <ProgressBar
      className="settingsLoading"
      indeterminate
      label={t("loadingSettings")}
    />
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
} as const satisfies Record<
  SettingsTab,
  { label: MessageKey; icon: string; component: ComponentType }
>;
