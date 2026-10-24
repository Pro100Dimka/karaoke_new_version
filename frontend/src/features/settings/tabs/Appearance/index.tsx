import {
  Card,
  Checkbox,
  Divider,
  Grid,
  IconButton,
  RotaryKnob,
  Select,
  Stack,
  ThemePicker,
} from "@neo-ui-kit/react";
import { useApp } from "../../../../app/AppContext";
import { appThemes } from "../../../../app/appTheme";
import { useRadio } from "../../../../app/RadioContext";
import type { ThemeName } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { ProfileSettings } from "../../../social/ProfileSettings";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import {
  fontOptions,
  langs,
  radioStationOptions,
  themeOptions,
} from "./ui/appearanceOptions";
import "./ui/appearance.css";

const toggles = [
  ["reducedMotion", "reduceAnimations"],
  ["discordPresence", "discordPresence"],
  ["autoUpdate", "autoUpdate"],
] as const;

export const AppearanceSettings = () => {
  const { preferences, updatePreferences } = useApp("preferences");
  const radio = useRadio();
  const t = useText();
  const fonts = fontOptions.map(({ value, label }) => ({
    value,
    label: t(label),
  }));
  return (
    <div className="settingsStack appearanceStack">
      <div className="appearanceLayout">
        <section className="appearanceThemePanel">
          <Card
            border
            icon="palette"
            title={t("theme")}
            className="appearanceThemeCard"
          >
            <ThemePicker<ThemeName>
              label={t("theme")}
              value={preferences.theme}
              onValueChange={(theme) => updatePreferences({ theme })}
              options={themeOptions.map(({ value, label, color }) => ({
                value,
                label: t(label),
                image: appThemes[value].icon,
                color,
              }))}
            />
          </Card>
        </section>
        <section className="appearanceProfilePanel">
          <ProfileSettings />
        </section>
        <section className="appearanceRadioPanel">
          <Card border icon="radio" title={t("radio")}>
            <Stack
              className="appearanceRadioControls"
              direction="row"
              gap={3}
              align="center"
            >
              <Select
                label={t("radioStation")}
                icon="radio"
                disabled={!radio.canControl}
                value={radio.stationId}
                options={radioStationOptions}
                onValueChange={radio.setStation}
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
                value={preferences.radioVolume}
                resetValue={60}
                onValueChange={(radioVolume) =>
                  updatePreferences({ radioVolume })
                }
              />
            </Stack>
          </Card>
        </section>
        <section className="appearanceInterfacePanel">
          <Card
            border
            icon="sliders"
            title={t("interfaceSettings")}
            className="appearanceInterfaceCard"
          >
            <Stack gap={4}>
              <Grid
                columns={12}
                gap={3}
                align="center"
                className="ad-form-fields"
              >
                {(["headingFont", "textFont"] as const).map((name) => (
                  <Grid
                    key={name}
                    span={{ base: "full", sm: 4 }}
                    className="ad-form-field"
                  >
                    <Select
                      label={t(name)}
                      value={preferences[name]}
                      options={fonts}
                      onValueChange={(value) =>
                        updatePreferences({ [name]: value })
                      }
                    />
                  </Grid>
                ))}
                <Grid span={{ base: "full", sm: 4 }} className="ad-form-field">
                  <Select
                    label={t("language")}
                    value={preferences.language}
                    options={[...langs]}
                    onValueChange={(language) =>
                      updatePreferences({ language })
                    }
                  />
                </Grid>
              </Grid>
              <Divider />
              <Grid
                columns={12}
                gap={3}
                align="center"
                className="ad-form-fields"
              >
                {toggles.map(([name, label]) => (
                  <Grid
                    key={name}
                    span={{ base: "full", sm: 4 }}
                    className="ad-form-field"
                  >
                    <Checkbox
                      label={t(label)}
                      checked={preferences[name]}
                      onValueChange={(value) =>
                        updatePreferences({ [name]: value })
                      }
                    />
                  </Grid>
                ))}
              </Grid>
            </Stack>
          </Card>
        </section>
      </div>
      <KeyboardLightingSettings />
    </div>
  );
};
