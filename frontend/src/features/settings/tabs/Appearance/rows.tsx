import type { FormFieldDefinition } from "@ad-voice/ui";
import type { ITranslate } from "../../../../i18n/useText";
import type { SettingsFormValues } from "../../settingsForm";
import { fontOptions, langs, radioStationOptions } from "./consts";

const getRows = (
  t: ITranslate,
  canControlRadio: boolean,
): readonly FormFieldDefinition<SettingsFormValues>[] => [
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
  {
    name: "headingFont",
    label: t("headingFont"),
    kind: "select",
    span: { base: "full", sm: 4 },
    props: {
      options: fontOptions.map((option) => ({
        value: option.value,
        label: t(option.label),
      })),
    },
  },
  {
    name: "textFont",
    label: t("textFont"),
    span: { base: "full", sm: 4 },
    kind: "select",
    props: {
      options: fontOptions.map((option) => ({
        value: option.value,
        label: t(option.label),
      })),
    },
  },
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
export default getRows;
