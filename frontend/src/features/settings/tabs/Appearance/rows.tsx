import type { FormFieldDefinition } from "@neo-ui-kit/react";
import type { ITranslate } from "../../../../i18n/useText";
import type { SettingsFormValues } from "../../settingsForm";
import { fontOptions, langs } from "./consts";

type Rows = readonly FormFieldDefinition<SettingsFormValues>[];

const getRows = (t: ITranslate): { selects: Rows; toggles: Rows } => {
  const fonts = fontOptions.map(({ value, label }) => ({
    value,
    label: t(label),
  }));
  const toggleLabels = {
    reducedMotion: "reduceAnimations",
    discordPresence: "discordPresence",
    autoUpdate: "autoUpdate",
  } as const;
  return {
    selects: [
      ...(["headingFont", "textFont"] as const).map((name) => ({
        name,
        label: t(name),
        kind: "select" as const,
        span: { base: "full" as const, sm: 4 },
        props: { options: fonts },
      })),
      {
        name: "language",
        label: t("language"),
        kind: "select",
        span: { base: "full", sm: 4 },
        props: { options: langs },
      },
    ],
    toggles: (["reducedMotion", "discordPresence", "autoUpdate"] as const).map(
      (name) => ({
        name,
        label: t(toggleLabels[name]),
        span: { base: "full" as const, sm: 4 },
        kind: "checkbox" as const,
      }),
    ),
  };
};
export default getRows;
