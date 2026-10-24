import { FormApi, Grid, type FormFieldDefinition } from "@neo-ui-kit/react";
import type { ComponentProps } from "react";
import { SettingsFormValues } from "..";
import { radioStations } from "../../../app/radioStations";
import type { ITranslate } from "../../../i18n/useText";
import {
  fontOptions,
  langs,
} from "../../settings/tabs/Appearance/ui/appearanceOptions";

export const blocks = (t: ITranslate, form: FormApi<SettingsFormValues>) => {
  const fonts = fontOptions.map(({ value, label }) => ({
    value,
    label: t(label),
  }));
  return {
    profile: {
      span: { base: "full", md: 6 },
      icon: "profile",
      fields: [
        {
          name: "photo",
          kind: "file",
          span: { sm: 3 },
          props: { variant: "avatar", accept: "image/*" },
        },
        {
          name: "preferences.displayName",
          label: t("displayName"),
          span: { sm: 9 },
        },
      ],
    },
    radio: {
      span: { base: "full", md: 6 },
      icon: "radio",
      fields: [
        {
          name: "radio.volume",
          kind: "rotary",
          span: { sm: 3 },
          props: { size: "xs", showLabel: true, suffix: "%" },
        },
        {
          name: "radio.stationId",
          label: t("radioStation"),
          kind: "select",
          props: {
            options: radioStations.map(({ id, name }) => ({
              value: id,
              label: name,
            })),
          },
          span: { sm: 6 },
        },
        {
          name: "radio.enabled",
          kind: "switch",
          span: { md: 3 },
          props: { disabled: !form?.values?.radio.canControl },
        },
      ],
    },
    keyboardLighting: {
      show: false,
      span: { base: "full" },
      icon: "bulb",
      fields: [
        {
          name: "preferences.keyboardLighting.enabled",
          kind: "switch",
          label: t("enabled"),
          span: { base: "full", sm: 3 },
        },
        {
          name: "preferences.keyboardLighting.mode",
          kind: "select",
          label: t("lightingMode"),
          span: { base: "full", sm: 3 },
          props: {
            options: [
              { value: "theme", label: t("lightingThemeMode") },
              { value: "music", label: t("lightingMusicMode") },
            ],
          },
        },
        {
          name: "preferences.keyboardLighting.brightness",
          kind: "slider",
          label: t("lightingBrightness"),
          span: { base: "full", sm: 3 },
          props: { min: 0, max: 100 },
        },
        {
          name: "preferences.keyboardLighting.sensitivity",
          kind: "slider",
          label: t("lightingSensitivity"),
          span: { base: "full", sm: 3 },
          props: { min: 0, max: 100 },
        },
      ],
    },
    interfaceSettings: {
      span: { base: "full" },
      icon: "sliders",
      fields: [
        {
          name: "preferences.headingFont",
          kind: "select",
          label: t("headingFont"),
          span: { base: "full", sm: 4 },
          props: { options: fonts },
        },
        {
          name: "preferences.textFont",
          kind: "select",
          label: t("textFont"),
          span: { base: "full", sm: 4 },
          props: { options: fonts },
        },
        {
          name: "preferences.language",
          kind: "select",
          label: t("language"),
          span: { base: "full", sm: 4 },
          props: { options: [...langs] },
        },
        {
          name: "preferences.reducedMotion",
          kind: "checkbox",
          label: t("reduceAnimations"),
          span: { base: "full", sm: 4 },
        },
        {
          name: "preferences.discordPresence",
          kind: "checkbox",
          label: t("discordPresence"),
          span: { base: "full", sm: 4 },
        },
        {
          name: "preferences.autoUpdate",
          kind: "checkbox",
          label: t("autoUpdate"),
          span: { base: "full", sm: 4 },
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
