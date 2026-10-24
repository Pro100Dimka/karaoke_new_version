import { Grid, ThemePicker, type FormApi } from "@neo-ui-kit/react";
import type { SettingsFormValues } from "..";
import { appThemes } from "../../../app/appTheme";
import type { ThemeName } from "../../../contracts/models";
import { useText } from "../../../i18n/useText";
import "../../settings/tabs/Appearance/ui/appearance.css";
import { themeOptions } from "../../settings/tabs/Appearance/ui/appearanceOptions";
import FormCard from "./FormCard";
import { blocks } from "./consts";

interface IAppearancePanelProps {
  form: FormApi<SettingsFormValues>;
  updatePreferences: (
    preferences: Partial<SettingsFormValues["preferences"]>,
  ) => void;
}
const AppearancePanel = ({
  form,
  updatePreferences,
}: IAppearancePanelProps) => {
  const t = useText();

  return (
    <Grid className="settingsAppearance" columns={12} gap={3}>
      <Grid span={{ base: "full", lg: 3 }}>
        <FormCard
          title={t("theme")}
          icon="palette"
          style={{
            display: "flex",
            flexDirection: "column",
          }}
        >
          <ThemePicker<ThemeName>
            className="appearanceThemeIcons"
            label={t("theme")}
            value={form.values.preferences.theme}
            onValueChange={(theme) => {
              form.setValue("preferences.theme", theme);
              updatePreferences({ theme });
            }}
            options={themeOptions.map(({ value, label, color }) => ({
              value,
              label: t(label),
              image: appThemes[value].icon,
              color,
            }))}
          />
        </FormCard>
      </Grid>
      <Grid span={{ base: "full", lg: 9 }}>
        <Grid columns={12} gap={3} style={{ height: "100%" }}>
          {Object.entries(blocks(t, form))
            .filter(([, block]) => !("show" in block) || block.show)
            .map(([name, { span, fields, icon }]) => (
              <Grid span={span} key={name}>
                <FormCard
                  title={t(name as Parameters<typeof t>[0])}
                  icon={icon}
                  fields={fields}
                />
              </Grid>
            ))}
        </Grid>
      </Grid>
    </Grid>
  );
};
export default AppearancePanel;
