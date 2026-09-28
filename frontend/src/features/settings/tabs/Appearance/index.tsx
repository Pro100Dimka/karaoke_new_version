import { useId, useMemo } from "react";
import { useApp } from "../../../../app/AppContext";
import { useRadio } from "../../../../app/RadioContext";
import { useText } from "../../../../i18n/useText";
import { RenderFormikFields, useGetForm } from "../../../../theme/ui";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import getRows from "./rows";
import "./appearance.css";

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
      radio: {
        enabled: radio.enabled,
        stationId: radio.stationId,
        volume: radio.volume,
      },
    }),
    [preferences, radio.enabled, radio.stationId, radio.volume],
  );
  const formik = useGetForm({ initialValues, onSubmit: () => undefined });
  const rows = getRows(t, radio, updatePreferences);
  return (
    <section aria-labelledby={titleId} style={{ paddingTop: "0.5rem" }}>
      <RenderFormikFields formik={formik} items={rows} />
      <KeyboardLightingSettings />
    </section>
  );
};
