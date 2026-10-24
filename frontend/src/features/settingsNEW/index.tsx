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
import { SettingsProvider } from "../../app/SettingsProvider";
import { useSocialDirectory } from "../../app/SocialProvider";
import { SocialDirectoryPort } from "../../application/social/SocialDirectory";
import { SettingsTab } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Preferences } from "../../shared/preferences/preferences";
import { SettingsAtmosphere } from "../../shared/ui/Atmosphere";
import "../settings/settings.css";
import Appearance from "./Appearance";
export type SettingsFormValues = {
  preferences: Preferences;
  directory: SocialDirectoryPort;
  radio: RadioContextValue;
};
const SettingsModal = () => {
  const { settingsTab } = useSettingsDialog();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(settingsTab);
  const directory = useSocialDirectory();
  const t = useText();
  const { preferences, updatePreferences } = useApp("preferences");
  const radio = useRadio();
  const keys = ["preferences", "radio"] as const;
  const vals = { preferences, directory, radio };
  const form = useForm<SettingsFormValues>({
    reinitialize: false,
    initialValues: { preferences, directory, radio },
    onSubmit: ({ preferences }) => {
      updatePreferences(preferences);
    },
  });
  useEffect(
    () => {
      const funcs = {
        preferences: () => updatePreferences(form.values.preferences),
        radio: () => {
          const next = form.values.radio;
          if (next.stationId !== radio.stationId)
            radio.setStation(next.stationId);
          if (next.volume !== radio.volume) radio.setVolume(next.volume);
          if (next.enabled !== radio.enabled) radio.toggle();
        },
      };
      keys.forEach((key) => {
        if (JSON.stringify(form.values[key]) !== JSON.stringify(vals[key])) {
          funcs[key]();
        }
      });
    },
    keys.map((key) => JSON.stringify(form.values[key])),
  );
  const tabs = { appearance: { Component: Appearance, icon: "palette" } };
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
          <SettingsProvider>
            <Form form={form} className="settingsBody">
              <Content updatePreferences={updatePreferences} form={form} />
            </Form>
          </SettingsProvider>
        </div>
      </Dialog>
    </>
  );
};
export default SettingsModal;
