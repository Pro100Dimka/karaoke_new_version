import type { Preferences } from "../../shared/preferences/preferences";
import { toAudioValues, type AudioValues } from "./tabs/Audio/settingsModel";

/** One form model for every persisted setting; audio is flattened for the device controls. */
export type SettingsFormValues = Omit<Preferences, "audio"> & AudioValues;

export const toSettingsFormValues = (
  preferences: Preferences,
  radioStation: string,
): SettingsFormValues => ({
  ...preferences,
  ...toAudioValues(preferences.audio),
  radioStation,
});
