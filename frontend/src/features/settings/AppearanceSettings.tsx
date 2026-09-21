import { useId, useMemo } from "react";
import { useApp } from "../../app/AppContext";
import { useRadio } from "../../app/RadioContext";
import { radioStations } from "../../app/radioStations";
import type { Language } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { RenderFormikFields, useGetForm, type ControlComponent, type FormRow } from "../../theme/ui";
import { ThemePicker } from "./ThemePicker";

const languageOptions = [
  { value: "uk", label: "Українська" },
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" }
] as const satisfies readonly { value: Language; label: string }[];

const components: Readonly<Record<string, ControlComponent>> = { ThemePicker: ThemePicker as unknown as ControlComponent };
const wide = { md: 12 } as const;

export const AppearanceSettings = () => {
  const { preferences, updatePreferences } = useApp();
  const radio = useRadio();
  const t = useText();
  const titleId = useId();

  const initialValues = useMemo(
    () => ({
      displayName: preferences.displayName,
      language: preferences.language,
      theme: preferences.theme,
      reducedMotion: preferences.reducedMotion,
      radio: { enabled: radio.enabled, stationId: radio.stationId, volume: radio.volume }
    }),
    [preferences, radio.enabled, radio.stationId, radio.volume]
  );
  // Everything here applies the moment it changes, so the form only mirrors the live preferences.
  const formik = useGetForm({ initialValues, onSubmit: () => undefined });

  const rows: FormRow[] = [
    { tag: "displayName", label: t("onlineDisplayName"), maxLength: 40, md: 6, onSave: value => updatePreferences({ displayName: String(value) }) },
    { type: "SelectField", tag: "language", label: t("language"), options: languageOptions, md: 6, onSave: value => updatePreferences({ language: value as Language }) },
    { type: "ThemePicker", tag: "theme", ...wide, onSave: value => updatePreferences({ theme: value as typeof preferences.theme }) },
    { type: "SwitchField", tag: "reducedMotion", variant: "plain", label: t("reduceAnimations"), ...wide, onSave: value => updatePreferences({ reducedMotion: Boolean(value) }) },
    { type: "Label", variant: "h3", text: t("radio"), ...wide },
    {
      type: "SwitchField",
      tag: "radio.enabled",
      variant: "plain",
      label: t("radioEnabled"),
      md: 4,
      onSave: value => {
        if (Boolean(value) !== radio.enabled) radio.toggle();
      }
    },
    { type: "SelectField", tag: "radio.stationId", label: t("radioStation"), options: radioStations.map(station => ({ value: station.id, label: station.name })), md: 4, onSave: value => radio.setStation(String(value)) },
    { type: "Slider", tag: "radio.volume", label: t("radioVolume"), min: 0, max: 100, md: 4, onSave: value => radio.setVolume(Number(value)) }
  ];

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>{t("appearance")}</h2>
      <RenderFormikFields formik={formik} items={rows} components={components} />
    </section>
  );
};
