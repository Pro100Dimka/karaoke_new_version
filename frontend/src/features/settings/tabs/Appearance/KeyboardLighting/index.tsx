import { useEffect, useState } from "react";
import {
  Card,
  Grid,
  Select,
  Slider,
  Stack,
  Switch,
  Typography,
  type FormApi,
} from "@ad-voice/ui";
import { useText } from "../../../../../i18n/useText";
import { keyboardLightingClient } from "../../../../../services/keyboardLightingClient";
import type { SettingsFormValues } from "../../../settingsForm";

export const KeyboardLightingSettings = ({
  form,
}: {
  form: FormApi<SettingsFormValues>;
}) => {
  const t = useText();
  const [capabilities, setCapabilities] =
    useState<KeyboardLightingCapabilities>();
  const lighting = form.values.keyboardLighting;

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void keyboardLightingClient
        .capabilities()
        .then((value) => active && setCapabilities(value));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!capabilities?.available) return null;
  const update = (patch: Partial<typeof lighting>) => {
    const next = { ...lighting, ...patch };
    form.setValue("keyboardLighting", next);
    void keyboardLightingClient
      .apply(next, form.values.theme)
      .catch(() => undefined);
  };
  const levels = [
    { key: "brightness", label: t("lightingBrightness") },
    { key: "sensitivity", label: t("lightingSensitivity") },
  ] as const;

  return (
    <Card
      border
      icon="bulb"
      title={t("keyboardLighting")}
      description={t("keyboardLightingStatus", {
        provider: capabilities.provider ?? "OpenRGB",
        count: capabilities.deviceCount,
      })}
    >
      <Grid minChildWidth="min(100%, 12rem)" gap={4} align="end">
        <Switch
          label={t("enabled")}
          checked={lighting.enabled}
          onValueChange={(enabled) => update({ enabled })}
        />
        <Select
          label={t("lightingMode")}
          value={lighting.mode}
          options={[
            { value: "theme", label: t("lightingThemeMode") },
            { value: "music", label: t("lightingMusicMode") },
          ]}
          onValueChange={(mode) =>
            update({ mode: mode as typeof lighting.mode })
          }
        />
        {levels.map((level) => (
          <Stack key={level.key} gap={2}>
            <Typography variant="label">{level.label}</Typography>
            <Slider
              label={level.label}
              min={0}
              max={100}
              value={lighting[level.key]}
              onValueChange={(value) => update({ [level.key]: value })}
            />
          </Stack>
        ))}
      </Grid>
    </Card>
  );
};
