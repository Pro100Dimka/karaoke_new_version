import {
  AnimatedBorder,
  BrandMark,
  Dialog,
  Form,
  Planet,
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

// Closing the dialog releases its form and device lifecycle.
const SettingsModal = () => {
  const { settingsOpen } = useSettingsDialog();
  return settingsOpen ? <SettingsProvider><SettingsModalContent /></SettingsProvider> : null;
};

const SettingsModalContent = () => {
  const { settingsOpen, setSettingsOpen } = useSettingsDialog();
  const t = useText();
  const [stage, setStage] = useState(0);
  useEffect(() => setStage(1), []);
  useEffect(() => {
    if (stage !== 1) return;
    const frame = requestAnimationFrame(() => setStage(2));
    return () => cancelAnimationFrame(frame);
  }, [stage]);
  return (
    <Dialog
      open={settingsOpen && stage > 0}
      onOpenChange={(open) => !open && setSettingsOpen(false)}
      className="settingsDialog"
      width="full"
      icon="settings"
      title={t("settings")}
      description={t("settingsDescription")}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={false}
      art={stage === 2 &&
        <>
          <SettingsAtmosphere className="settingsAtmosphere" />
          <Planet className="settingsHeaderArt" />
          <AnimatedBorder shell className="settingsFrame" />
          <BrandMark className="settingsSignature" />
        </>
      }
    >
      {stage === 2 && <SettingsFormContent />}
    </Dialog>
  );
};

const SettingsFormContent = () => {
  const { settingsTab } = useSettingsDialog();
  const t = useText();
  const form = useSettingsForm();
  const [tab, setTab] = useState(settingsTab);
  useEffect(() => setTab(settingsTab), [settingsTab]);
  const Content = tabs[tab].component;
  return (
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
        <Content form={form} />
      </div>
    </Form>
  );
};

export default SettingsModal;
