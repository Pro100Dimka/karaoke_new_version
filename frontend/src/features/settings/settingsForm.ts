import { useEffect, useRef } from "react";
import { useForm, type FormApi } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import { useRadio } from "../../app/RadioContext";
import type { Preferences } from "../../shared/preferences/preferences";
import { toAudioValues, type AudioValues } from "./tabs/Audio/settingsModel";

/** One form model for every persisted setting; audio is flattened for the device controls. */
export type SettingsFormValues = Omit<Preferences, "audio"> & AudioValues;

export const toSettingsFormValues = (
  preferences: Preferences,
  radioStation: string,
): SettingsFormValues => {
  const { audio, ...local } = preferences;
  return { ...local, ...toAudioValues(audio), radioStation };
};

/** The root owns the form. Device writes are accepted separately by AudioService. */
export const useSettingsForm = (): FormApi<SettingsFormValues> => {
  const { preferences, updatePreferences } = useApp();
  const radio = useRadio();
  const base = useForm({
    initialValues: toSettingsFormValues(preferences, radio.stationId),
    reinitialize: false,
  });
  const current = useRef(base.values);
  current.current = base.values;
  const setValue = (path: string, value: unknown) => {
    current.current = { ...current.current, [path]: value };
    base.setValue(path, value);
    if (path === "radioStation") radio.setStation(String(value));
    else if (Object.hasOwn(preferences, path))
      updatePreferences({ [path]: value } as Partial<Preferences>);
  };
  // External profile/radio changes update their fields without resetting pending device edits.
  useEffect(() => {
    const { audio: _, ...local } = preferences;
    for (const [path, value] of Object.entries({
      ...local,
      radioStation: radio.stationId,
    }))
      if (!Object.is(current.current[path as keyof SettingsFormValues], value))
        base.setValue(path, value);
  }, [preferences, radio.stationId, base.setValue]);
  return {
    ...base,
    setValue,
    field: (path) => ({
      ...base.field(path),
      onValueChange: (value) => setValue(path, value),
    }),
  };
};
