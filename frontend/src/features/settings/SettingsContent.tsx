import type { SettingsTab } from "../../contracts/models";
import { AdvancedSettings } from "./tabs/Advanced";
import { AiSettings } from "./tabs/Ai";
import { AppearanceSettings } from "./tabs/Appearance";
import { AudioSettings, type AudioSettingsProps } from "./tabs/Audio";
import { SecretsSettings } from "./tabs/Secrets";

export const SettingsContent = ({ tab, ...audio }: { tab: SettingsTab } & AudioSettingsProps) => {
  if (tab === "appearance") return <AppearanceSettings />;
  if (tab === "audio") return <AudioSettings {...audio} />;
  if (tab === "ai") return <AiSettings />;
  if (tab === "environment") return <SecretsSettings />;
  return <AdvancedSettings />;
};
