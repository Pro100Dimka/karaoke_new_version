import { Card, FormFields, ThemePicker, type FormApi } from "@ad-voice/ui";
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
