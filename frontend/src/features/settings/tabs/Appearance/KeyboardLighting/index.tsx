import {
  Card,
  Grid,
  Select,
  Slider,
  Stack,
  Switch,
  Typography,
} from "@neo-ui-kit/react";
import { useText } from "../../../../../i18n/useText";

import { useKeyboardLighting } from "./hooks/useKeyboardLighting";

const levels = [
  { key: "brightness", label: "lightingBrightness" },
  { key: "sensitivity", label: "lightingSensitivity" },
] as const;

export const KeyboardLightingSettings = () => {
  const t = useText();
  const { lighting, capabilities, update } = useKeyboardLighting();
  if (!capabilities?.available) return null;

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
        <Select<typeof lighting.mode>
          label={t("lightingMode")}
          value={lighting.mode}
          options={[
            { value: "theme", label: t("lightingThemeMode") },
            { value: "music", label: t("lightingMusicMode") },
          ]}
          onValueChange={(mode) => update({ mode })}
        />
        {levels.map((level) => (
          <Stack key={level.key} gap={2}>
            <Typography variant="label">{t(level.label)}</Typography>
            <Slider
              label={t(level.label)}
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
