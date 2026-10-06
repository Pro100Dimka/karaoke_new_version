import type { FormFieldDefinition } from "@ad-voice/ui";
import type { ITranslate } from "../../../../i18n/useText";
import type { SettingsFormValues } from "../../settingsForm";
import { fontOptions, langs, radioStationOptions } from "./consts";

const getRows = (
  t: ITranslate,
  canControlRadio: boolean,
): readonly FormFieldDefinition<SettingsFormValues>[] => {
  const fonts = fontOptions.map(({ value, label }) => ({
    value,
    label: t(label),
  }));
  return [
    {
      name: "displayName",
      label: t("onlineDisplayName"),
      span: { base: "full", sm: 4 },
      props: { maxLength: 48 },
    },
    {
      name: "language",
      label: t("language"),
      kind: "select",
      span: { base: "full", sm: 4 },
      props: { options: langs },
    },
    ...(["headingFont", "textFont"] as const).map((name) => ({
      name,
      label: t(name),
      kind: "select" as const,
      span: { base: "full" as const, sm: 4 },
      props: { options: fonts },
    })),
    {
      name: "reducedMotion",
      label: t("reduceAnimations"),
      span: { base: "full", sm: 4 },
      kind: "checkbox",
    },
    {
      name: "radioStation",
      label: t("radioStation"),
      span: { base: "full", sm: 4 },
      kind: "select",
      props: {
        icon: "radio",
        disabled: !canControlRadio,
        options: radioStationOptions,
      },
    },
  ];
};
export default getRows;
