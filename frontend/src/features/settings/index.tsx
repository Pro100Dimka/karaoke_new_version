import {
  AnimatedBorder,
  BrandMark,
  Dialog,
  Form,
  Planet,
  ProgressBar,
  Tabs,
} from "@ad-voice/ui";
import { useEffect, useState } from "react";
import { useSettingsDialog } from "../../app/AppContext";
import type { SettingsTab } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { SettingsAtmosphere } from "../../shared/ui/Atmosphere";
import { useSettingsForm } from "./settingsForm";
import { AdvancedSettings } from "./tabs/Advanced";
import { AiSettings } from "./tabs/Ai";
import { AppearanceSettings } from "./tabs/Appearance";
import { AudioSettings } from "./tabs/Audio";
import { useAudioSettings } from "./tabs/Audio/useAudioSettings";
import { SecretsSettings } from "./tabs/Secrets";
import "./settings.css";

const tabs = {
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

// Closing the dialog releases its form and device lifecycle.
const SettingsSession = ({
  initialTab,
  onClose,
}: {
  initialTab: SettingsTab;
  onClose(): void;
}) => {
  const t = useText();
  const form = useSettingsForm();
  const { ready, audio } = useAudioSettings(form);
  const [tab, setTab] = useState(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const Content = tabs[tab].component;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
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
          <SettingsAtmosphere className="settingsAtmosphere" />
          <Planet className="settingsHeaderArt" />
          <AnimatedBorder shell className="settingsFrame" />
          <BrandMark className="settingsSignature" />
        </>
      }
    >
      {ready ? (
        <Form form={form} className="settingsForm">
          <Tabs<SettingsTab>
            className="settingsNav"
            value={tab}
            onValueChange={setTab}
            items={(Object.keys(tabs) as SettingsTab[]).map((value) => ({
              value,
              label: t(tabs[value].label),
              icon: tabs[value].icon,
            }))}
          />
          <div className="settingsBody">
            <Content {...audio} />
          </div>
        </Form>
      ) : (
        <ProgressBar
          className="settingsLoading"
          indeterminate
          label={t("loadingSettings")}
        />
      )}
    </Dialog>
  );
};
export const SettingsModal = () => {
  const { settingsOpen, settingsTab, setSettingsOpen } = useSettingsDialog();
  return settingsOpen ? (
    <SettingsSession
      initialTab={settingsTab}
      onClose={() => setSettingsOpen(false)}
    />
  ) : null;
};
export default SettingsModal;
