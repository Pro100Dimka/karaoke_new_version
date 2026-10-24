import {
  AnimatedBorder,
  BrandMark,
  Dialog,
  Form,
  IconButton,
  Planet,
  Tabs,
  useForm,
} from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import { useApp, useSettingsDialog } from "../../app/AppContext";
import { RadioContextValue, useRadio } from "../../app/RadioContext";
import { useSocialDirectory } from "../../app/SocialProvider";
import { SocialDirectoryPort } from "../../application/social/SocialDirectory";
import { SettingsTab } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Preferences } from "../../shared/preferences/preferences";
import { SettingsAtmosphere } from "../../shared/ui/Atmosphere";
import "../settings/settings.css";
import { useAiSettings } from "../settings/tabs/Ai/hooks/useAiSettings";
import AI from "./Ai";
import Appearance from "./Appearance";

export type SettingsFormValues = {
  preferences: Preferences;
  directory: SocialDirectoryPort;
  radio: RadioContextValue;
  ai: ReturnType<typeof useAiSettings>;
};
const SettingsModal = () => {
  const { settingsTab } = useSettingsDialog();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(settingsTab);
  const directory = useSocialDirectory();
  const t = useText();
  const { preferences, updatePreferences } = useApp("preferences");
  const radio = useRadio();
  const ai = useAiSettings();
  const keys = ["preferences", "radio"] as const;
  const vals = { preferences, directory, radio, ai };
  const updateData = (values: SettingsFormValues) => {
    const funcs = {
      preferences: () => updatePreferences(values.preferences),
      radio: () => {
        const next = values.radio;
        const actions = {
          stationId: () => radio.setStation(next.stationId),
          volume: () => radio.setVolume(next.volume),
          enabled: radio.toggle,
        };
        (Object.keys(actions) as (keyof typeof actions)[]).forEach(
          (key) => next[key] !== radio[key] && actions[key](),
        );
      },
    };
    keys.forEach((key) => {
      if (JSON.stringify(values[key]) !== JSON.stringify(vals[key])) {
        funcs[key]();
      }
    });
  };
  const form = useForm<SettingsFormValues>({
    reinitialize: false,
    initialValues: vals,
    onSubmit: updateData,
  });
  useEffect(
    () => updateData(form.values),
    keys.map((key) => JSON.stringify(form.values[key])),
  );
  const tabs = {
    appearance: { Component: Appearance, icon: "palette" },
    aiProcessing: { Component: AI, icon: "chip" },
  };
  const Content = tabs[tab as keyof typeof tabs].Component;
  return (
    <>
      <IconButton
        round
        size="lg"
        className="floatingButton"
        icon="settings"
        label={t("settings")}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={(open) => !open && setOpen(false)}
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
        <div className="settingsForm">
          <Tabs
            className="settingsNav"
            value={tab}
            onValueChange={(value: SettingsTab) => setTab(value)}
            items={(Object.keys(tabs) as SettingsTab[]).map((value) => ({
              value,
              label: t(value as Parameters<typeof t>[0]),
              icon: tabs[value as keyof typeof tabs].icon,
            }))}
          />
          <Form form={form} className="settingsBody">
            <Content updatePreferences={updatePreferences} form={form} />
          </Form>
        </div>
      </Dialog>
    </>
  );
};
export default SettingsModal;
