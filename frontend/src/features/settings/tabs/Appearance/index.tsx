import {
  Card,
  Divider,
  FormFields,
  IconButton,
  RotaryKnob,
  Select,
  Stack,
  ThemePicker,
  type FormApi,
} from "@neo-ui-kit/react";
import { appThemes } from "../../../../app/appTheme";
import { useRadio } from "../../../../app/RadioContext";
import type { ThemeName } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { ProfileSettings } from "../../../social/ProfileSettings";
import type { SettingsFormValues } from "../../settingsForm";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import { radioStationOptions, themeOptions } from "./consts";
import getRows from "./rows";

export const AppearanceSettings = ({
  form,
}: {
  form: FormApi<SettingsFormValues>;
}) => {
  const radio = useRadio();
  const t = useText();
  const rows = getRows(t);
  return (
    <div className="settingsStack appearanceStack">
      <div className="appearanceLayout">
        <section className="appearanceThemePanel">
          <Card border icon="palette" title={t("theme")} className="appearanceThemeCard">
            <ThemePicker<ThemeName>
              label={t("theme")}
              value={form.values.theme}
              onValueChange={(theme) => form.setValue("theme", theme)}
              options={themeOptions.map((option) => ({
                value: option.value,
                label: t(option.label),
                image: appThemes[option.value].icon,
                color: option.color,
              }))}
            />
          </Card>
        </section>
        <section className="appearanceProfilePanel">
          <ProfileSettings />
        </section>
        <section className="appearanceRadioPanel">
          <Card border icon="radio" title={t("radio")}>
            <Stack className="appearanceRadioControls" direction="row" gap={3} align="center">
              <Select
                label={t("radioStation")}
                icon="radio"
                disabled={!radio.canControl}
                value={form.values.radioStation}
                options={radioStationOptions}
                onValueChange={(station) => form.setValue("radioStation", station)}
                style={{ flex: 1 }}
              />
              <IconButton
                round
                size="lg"
                icon="radio"
                label={t("radioEnabled")}
                aria-pressed={radio.enabled}
                disabled={!radio.canControl}
                variant={radio.enabled ? "primary" : "secondary"}
                onClick={radio.toggle}
              />
              <RotaryKnob
                diameter={112}
                showLabel
                label={t("radioVolume")}
                value={form.values.radioVolume}
                resetValue={60}
                onValueChange={(volume) => form.setValue("radioVolume", volume)}
              />
            </Stack>
          </Card>
        </section>
        <section className="appearanceInterfacePanel">
          <Card border icon="sliders" title={t("interfaceSettings")} className="appearanceInterfaceCard">
            <Stack gap={4}>
              <FormFields fields={rows.selects} />
              <Divider />
              <FormFields fields={rows.toggles} />
            </Stack>
          </Card>
        </section>
      </div>
      <KeyboardLightingSettings form={form} />
    </div>
  );
};
