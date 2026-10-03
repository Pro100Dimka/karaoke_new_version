import { Card, Grid, Select, Slider, Stack, Switch, TextField, Typography } from "@ad-voice/ui";
import { useApp } from "../../../../app/AppContext";
import { useRadio } from "../../../../app/RadioContext";
import type { Language } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import ThemePicker from "../../../../theme/ui/ThemePicker";
import { ProfileSettings } from "../../../social/ProfileSettings";
import "./appearance.css";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import { langs, radioStationOptions } from "./consts";

const themeDescriptions: Record<Language, string> = {
  ru: "Выберите стиль, который подходит вам",
  uk: "Оберіть стиль, який вам пасує",
  en: "Choose the style that suits you",
};

export const AppearanceSettings = () => {
  const { preferences, updatePreferences } = useApp();
  const radio = useRadio();
  const t = useText();
  return (
    <div className="settingsStack appearanceStack">
      <ProfileSettings />

      <Card border className="appearancePreferences">
        <Grid role="group" aria-label={t("appearance")} minChildWidth="min(100%, 15rem)" gap={4} align="end">
          <TextField label={t("onlineDisplayName")} maxLength={48} value={preferences.displayName}
            onValueChange={displayName => updatePreferences({ displayName })} />
          <Select label={t("language")} value={preferences.language} options={[...langs]}
            onValueChange={language => updatePreferences({ language: language as Language })} />
          <Switch label={t("reduceAnimations")} checked={preferences.reducedMotion}
            onValueChange={reducedMotion => updatePreferences({ reducedMotion })} />
          <Select label={t("radioStation")} icon="radio" disabled={!radio.canControl} value={radio.stationId}
            options={radioStationOptions} onValueChange={radio.setStation} />
          <Stack gap={2}>
            <Stack direction="row" justify="between" align="center">
              <Typography variant="label">{t("radioVolume")}</Typography>
              <Typography variant="mono" tone="muted">{radio.volume}</Typography>
            </Stack>
            <Slider label={t("radioVolume")} min={0} max={100} value={radio.volume} onValueChange={radio.setVolume} />
          </Stack>
          <Switch label={t("radioEnabled")} disabled={!radio.canControl} checked={radio.enabled}
            onValueChange={radio.toggle} />
        </Grid>
      </Card>

      <Card border className="appearanceThemes" icon="palette" title={t("theme")}
        description={themeDescriptions[preferences.language]}>
        <ThemePicker value={preferences.theme} onChange={theme => updatePreferences({ theme })} />
      </Card>

      <KeyboardLightingSettings />
    </div>
  );
};
