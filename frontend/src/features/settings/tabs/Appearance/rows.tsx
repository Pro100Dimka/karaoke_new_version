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
      name: "language",
      label: t("language"),
      kind: "select",
      span: { base: "full", sm: 3 },
      props: { options: langs },
    },
    ...(["headingFont", "textFont"] as const).map((name) => ({
      name,
      label: t(name),
      kind: "select" as const,
      span: { base: "full" as const, sm: 3 },
      props: { options: fonts },
    })),
    {
      name: "reducedMotion",
      label: t("reduceAnimations"),
      span: { base: "full", sm: 3 },
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
    {
      name: "radioVolume",
      label: t("radioVolume"),
      span: { base: "full", sm: 4 },
      kind: "slider",
      props: { min: 0, max: 100 },
    },
    {
      name: "radioEnabled",
      label: t("radioEnabled"),
      span: { base: "full", sm: 4 },
      kind: "switch",
      props: { disabled: !canControlRadio },
    },
  ];
};
export default getRows;
