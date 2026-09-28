import { RadioContextValue } from "../../../../app/RadioContext";
import { ITranslate } from "../../../../i18n/useText";
import { type Preferences } from "../../../../shared/preferences/preferences";
import { langs, radioStationOptions } from "./consts";

export default (
  t: ITranslate,
  radio: RadioContextValue,
  updatePreferences: (patch: Partial<Preferences>) => void,
) => [
  {
    tag: "displayName",
    label: t("onlineDisplayName"),
    maxLength: 40,
    md: 5,
    onSave: (value: string) =>
      updatePreferences({ displayName: String(value) }),
  },
  {
    type: "SelectField",
    tag: "language",
    label: t("language"),
    options: langs,
    md: 4,
    onSave: (language: Preferences["language"]) => updatePreferences({ language }),
  },
  {
    type: "SwitchField",
    tag: "reducedMotion",
    variant: "plain",
    label: t("reduceAnimations"),
    md: 3,
    onSave: (reducedMotion: boolean) => updatePreferences({ reducedMotion }),
  },

  {
    type: "SelectField",
    tag: "radio.stationId",
    label: t("radioStation"),
    options: radioStationOptions,
    md: 5,
    onSave: radio.setStation,
  },
  {
    type: "Slider",
    tag: "radio.volume",
    label: t("radioVolume"),
    min: 0,
    max: 100,
    md: 4,
    onSave: radio.setVolume,
  },
  {
    type: "SwitchField",
    tag: "radio.enabled",
    variant: "plain",
    label: t("radioEnabled"),
    md: 3,
    onSave: (value: boolean) => {
      if (Boolean(value) !== radio.enabled) radio.toggle();
    },
  },
  {
    md: 12,
    type: "ThemePicker",
    tag: "theme",
    onSave: (theme: Preferences["theme"]) => updatePreferences({ theme }),
  },
];
