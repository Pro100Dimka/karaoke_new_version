import { FormApi, Grid, type FormFieldDefinition } from "@neo-ui-kit/react";
import type { ComponentProps } from "react";
import { SettingsFormValues } from "..";
import type { ITranslate } from "../../../i18n/useText";

export const blocks = (t: ITranslate, form: FormApi<SettingsFormValues>) => {
  return {
    processing: {
      span: { base: "full" },
      icon: "chip",
      fields: [
        {
          name: "ai.backend",
          kind: "select",
          label: t("aiProcessingBackend"),
          span: { base: "full", sm: 6 },
          props: {
            disabled: form?.values?.ai.savingBackend,
            options: [
              { value: "Local", label: t("aiBackendLocal") },
              { value: "Kaggle", label: t("aiBackendKaggle") },
            ],
          },
        },
        {
          name: "preferences.displayName",
          label: t("displayName"),
          span: { sm: 9 },
        },
      ],
    },
  } satisfies Record<
    string,
    {
      span: ComponentProps<typeof Grid>["span"];
      icon: string;
      show?: boolean;
      fields: FormFieldDefinition<Record<string, unknown>>[];
    }
  >;
};
