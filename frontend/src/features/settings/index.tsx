import {
  AnimatedBorder,
  BrandMark,
  Dialog,
  Planet,
  Tabs,
} from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import { useSettingsDialog } from "../../app/AppContext";
import type { SettingsTab } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { SettingsAtmosphere } from "../../shared/ui/Atmosphere";
import "./settings.css";
import { SettingsProvider } from "../../app/SettingsProvider";
import tabs from "./tabs";

const SettingsContents = ({ requestedTab }: { requestedTab: SettingsTab }) => {
  const t = useText();
  const [tab, setTab] = useState(requestedTab);
  useEffect(() => setTab(requestedTab), [requestedTab]);
  const Content = tabs[tab].component;

  return (
    <div className="settingsForm">
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
      <div key={tab} className="settingsBody">
        <Content />
      </div>
    </div>
  );
};

const SettingsWindow = ({
  requestedTab,
  onClose,
}: {
  requestedTab: SettingsTab;
  onClose(): void;
}) => {
  const t = useText();
  const [stage, setStage] = useState<"mounting" | "opening" | "ready">(
    "mounting",
  );

  // Open the native dialog after mount, then mount the tab and expensive scene
  // on the next frame. StrictMode's setup/cleanup replay never opens it twice.
  useEffect(() => {
    setStage("opening");
    const frame = requestAnimationFrame(() => setStage("ready"));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <Dialog
      open={stage !== "mounting"}
      onOpenChange={(open) => !open && onClose()}
      className="settingsDialog"
      width="full"
      icon="settings"
      title={t("settings")}
      description={t("settingsDescription")}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={false}
      art={
        stage === "ready" && (
          <>
            <SettingsAtmosphere className="settingsAtmosphere" />
            <Planet className="settingsHeaderArt" />
            <AnimatedBorder shell className="settingsFrame" />
            <BrandMark className="settingsSignature" />
          </>
        )
      }
    >
      {stage === "ready" && <SettingsContents requestedTab={requestedTab} />}
    </Dialog>
  );
};

const SettingsModal = () => {
  const { settingsOpen, settingsTab, setSettingsOpen } = useSettingsDialog();
  if (!settingsOpen) return null;

  return (
    <SettingsProvider>
      <SettingsWindow
        requestedTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
      />
    </SettingsProvider>
  );
};

export default SettingsModal;
