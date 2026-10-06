import {
  Card,
  FormFields,
  Grid,
  Slider,
  Stack,
  Switch,
  ThemePicker,
  Typography,
  type FormApi,
} from "@ad-voice/ui";
import { useRadio } from "../../../../app/RadioContext";
import { appThemes } from "../../../../app/appTheme";
import type { Language, ThemeName } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { ProfileSettings } from "../../../social/ProfileSettings";
import type { SettingsFormValues } from "../../settingsForm";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import { themeOptions } from "./consts";
import getRows from "./rows";

const themeDescriptions: Record<Language, string> = {
  ru: "Выберите стиль, который подходит вам",
  uk: "Оберіть стиль, який вам пасує",
  en: "Choose the style that suits you",
};

export const AppearanceSettings = ({
  form,
}: {
  form: FormApi<SettingsFormValues>;
}) => {
  const radio = useRadio();
  const t = useText();
  const rows = getRows(t, radio.canControl);
  return (
    <div className="settingsStack appearanceStack">
      <ProfileSettings />

      <Card border className="appearancePreferences">
        <FormFields fields={rows} />
        <Grid
          role="group"
          aria-label={t("appearance")}
          minChildWidth="min(100%, 15rem)"
          gap={4}
          align="end"
        >
          <Stack gap={2}>
            <Stack direction="row" justify="between" align="center">
              <Typography variant="label">{t("radioVolume")}</Typography>
              <Typography variant="mono" tone="muted">
                {form.values.radioVolume}
              </Typography>
            </Stack>
            <Slider
              label={t("radioVolume")}
              min={0}
              max={100}
              value={form.values.radioVolume}
              onValueChange={(radioVolume) =>
                form.setValue("radioVolume", radioVolume)
              }
            />
          </Stack>
          <Switch
            label={t("radioEnabled")}
            disabled={!radio.canControl}
            checked={radio.enabled}
            onValueChange={radio.toggle}
          />
        </Grid>
      </Card>

      <Card
        border
        className="appearanceThemes"
        icon="palette"
        title={t("theme")}
        description={themeDescriptions[form.values.language]}
      >
        <ThemePicker<ThemeName>
          label={t("theme")}
          value={form.values.theme}
          onValueChange={(theme) => form.setValue("theme", theme)}
          options={themeOptions.map((option) => ({
            value: option.value,
            label: t(option.label),
            description: t(option.description),
            image: appThemes[option.value].icon,
            color: option.color,
          }))}
        />
      </Card>

      <KeyboardLightingSettings form={form} />
    </div>
  );
};
