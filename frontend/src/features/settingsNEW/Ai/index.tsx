import { Grid, type FormApi } from "@neo-ui-kit/react";
import type { SettingsFormValues } from "..";
import { useText } from "../../../i18n/useText";
import FormCard from "../FormCard";
import { blocks } from "./consts";

interface IAppearancePanelProps {
  form: FormApi<SettingsFormValues>;
  updatePreferences: (
    preferences: Partial<SettingsFormValues["preferences"]>,
  ) => void;
}
const AIPanel = ({ form }: IAppearancePanelProps) => {
  const t = useText();

  return (
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
  );
};
export default AIPanel;
