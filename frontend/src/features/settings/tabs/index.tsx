import { AdvancedSettings } from "./Advanced";
import { AiSettings } from "./Ai";
import { AppearanceSettings } from "./Appearance";
import { AudioSettings } from "./Audio";
import { SecretsSettings } from "./Secrets";

export default {
  appearance: {
    label: "appearance",
    icon: "palette",
    component: AppearanceSettings,
  },
  audio: { label: "audio", icon: "volume", component: AudioSettings },
  ai: { label: "aiProcessing", icon: "chip", component: AiSettings },
  environment: {
    label: "environmentKeys",
    icon: "key",
    component: SecretsSettings,
  },
  advanced: { label: "advanced", icon: "wrench", component: AdvancedSettings },
} as const;
