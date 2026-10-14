import { Card, FormFields, type FormApi } from "@neo-ui-kit/react";
import { useRadio } from "../../../../app/RadioContext";
import { useText } from "../../../../i18n/useText";
import { ProfileSettings } from "../../../social/ProfileSettings";
import type { SettingsFormValues } from "../../settingsForm";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import getRows from "./rows";

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
      <ProfileSettings form={form} />
      <Card border className="appearancePreferences">
        <FormFields fields={rows} />
      </Card>
      <KeyboardLightingSettings form={form} />
    </div>
  );
};
