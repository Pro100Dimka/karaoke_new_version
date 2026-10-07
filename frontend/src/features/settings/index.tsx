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
import { SettingsProvider } from "../../app/SettingsProvider";
import type { SettingsTab } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { SettingsAtmosphere } from "../../shared/ui/Atmosphere";
import "./settings.css";
import { useSettingsForm } from "./settingsForm";
import tabs from "./tabs";
import { useAudioSettings } from "./tabs/Audio/useAudioSettings";

// Closing the dialog releases its form and device lifecycle.
const SettingsModal = () => {
  const { settingsOpen } = useSettingsDialog();
  return settingsOpen ? <SettingsProvider><SettingsModalContent /></SettingsProvider> : null;
};

const SettingsModalContent = () => {
  const { settingsOpen, settingsTab, setSettingsOpen } = useSettingsDialog();
  const t = useText();
  const form = useSettingsForm();
  const { ready, audio } = useAudioSettings(form);
  const [tab, setTab] = useState(settingsTab);
  useEffect(() => setTab(settingsTab), [settingsTab]);
  const Content = tabs[tab].component;
  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => !open && setSettingsOpen(false)}
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
          <Tabs
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

export default SettingsModal;
