import { Card, Grid, Select, Slider, Stack, Switch, TextField, ThemePicker, Typography } from "@ad-voice/ui";
import { useApp } from "../../../../app/AppContext";
import { useRadio } from "../../../../app/RadioContext";
import type { Language, ThemeName } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { appThemes } from "../../../../app/appTheme";
import { ProfileSettings } from "../../../social/ProfileSettings";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import { fontOptions, langs, radioStationOptions, themeOptions } from "./consts";
import type { AppFont } from "../../../../shared/preferences/appFonts";

const themeDescriptions: Record<Language, string> = {
  ru: "Выберите стиль, который подходит вам",
  uk: "Оберіть стиль, який вам пасує",
  en: "Choose the style that suits you",
};

export const AppearanceSettings = () => {
  const { preferences, updatePreferences } = useApp();
  const radio = useRadio();
  const t = useText();
  const fonts = fontOptions.map(option => ({ value: option.value, label: t(option.label) }));
  return (
    <div className="settingsStack appearanceStack">
      <ProfileSettings />

      <Card border className="appearancePreferences">
        <Grid role="group" aria-label={t("appearance")} minChildWidth="min(100%, 15rem)" gap={4} align="end">
          <TextField label={t("onlineDisplayName")} maxLength={48} value={preferences.displayName}
            onValueChange={displayName => updatePreferences({ displayName })} />
          <Select label={t("language")} value={preferences.language} options={[...langs]}
            onValueChange={language => updatePreferences({ language: language as Language })} />
          <Select label={t("headingFont")} value={preferences.headingFont} options={fonts}
            onValueChange={font => updatePreferences({ headingFont: font as AppFont })} />
          <Select label={t("textFont")} value={preferences.textFont} options={fonts}
            onValueChange={font => updatePreferences({ textFont: font as AppFont })} />
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
        <ThemePicker<ThemeName> label={t("theme")} value={preferences.theme} onValueChange={theme => updatePreferences({ theme })}
          options={themeOptions.map(option => ({ value: option.value, label: t(option.label), description: t(option.description), image: appThemes[option.value].icon, color: option.color }))} />
      </Card>

      <KeyboardLightingSettings />
    </div>
  );
};
