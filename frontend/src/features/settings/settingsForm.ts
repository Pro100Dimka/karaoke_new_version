import { useForm, type FormApi } from "@ad-voice/ui";
import { useEffect, useMemo } from "react";
import { useApp } from "../../app/AppContext";
import { useRadio } from "../../app/RadioContext";
import type { Preferences } from "../../shared/preferences/preferences";
import { toAudioValues, type AudioValues } from "./tabs/Audio/settingsModel";

export type SettingsFormValues = Omit<Preferences, "audio"> & AudioValues;

export const toSettingsFormValues = (
  { audio, ...preferences }: Preferences,
  radioStation: string,
): SettingsFormValues => ({
  ...preferences,
  ...toAudioValues(audio),
  radioStation,
});

export const useSettingsForm = (): FormApi<SettingsFormValues> => {
  const { preferences, updatePreferences } = useApp("preferences");
  const radio = useRadio();
  const initialValues = useMemo(
    () => toSettingsFormValues(preferences, radio.stationId),
    [preferences, radio.stationId],
  );
  const form = useForm({
    initialValues,
    reinitialize: false,
  });
  const setValue = (path: string, value: unknown) => {
    form.setValue(path, value);
    path === "radioStation"
      ? radio.setStation(String(value))
      : Object.hasOwn(preferences, path) &&
        updatePreferences({ [path]: value } as Partial<Preferences>);
  };

  useEffect(() => {
    const { audio, ...values } = preferences;
    for (const [path, value] of Object.entries({ ...values, radioStation: radio.stationId })) {
      if (!Object.is(form.values[path as keyof SettingsFormValues], value)) form.setValue(path, value);
    }
  }, [preferences, radio.stationId]);

  return {
    ...form,
    setValue,
    field: (path) => ({
      ...form.field(path),
      onValueChange: (value) => setValue(path, value),
    }),
  };
};
