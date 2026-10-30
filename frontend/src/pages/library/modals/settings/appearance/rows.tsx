import { FilePicker, themes, tr } from '@neo-ui-kit/react';
import { appThemes } from '../../../../../providers/theme/variants';
import { fonts, radioStations } from '../../../../../utils/consts';
import type { FormBlock, SettingsFormValues } from '../../../../../utils/contracts';

export const blocks = (values: Pick<SettingsFormValues, "profile" | "interface" | "application" | "integrations" | "radio" | "keyboardLighting">) => {
  const canControlRadio = values.radio.canControl;
  const fontOptions = Object.entries(fonts).map(([value, [label, font]]) => ({
    value,
    font,
    label: tr(label),
  }));
  return {
    theme: {
      span: { base: 'full', md: 3, lg: 4 },
      icon: 'palette',
      fields: [
        {
          name: 'interface.theme',
          kind: 'theme',
          label: tr('theme'),
          props: {
            options: Object.entries(appThemes).map(
              ([value, { preview, library }]) => ({
                value,
                label: tr(value),
                ...preview,
                color: themes[library][0],
              }),
            ),
          },
        },
      ],
    },
    profile: {
      span: { base: 'full', lg: 6 },
      icon: 'profile',
      fields: [
        {
          name: 'profile.photo',
          kind: 'custom',
          span: { base: 'full', sm: 3, lg: 4 },
          render: (field) => (
            <FilePicker
              variant="avatar"
              accept="image/*"
              disabled={!values.profile.canChangePhoto}
              src={values.profile.photo}
              name={values.profile.displayName}
              onFiles={field.onValueChange}
            />
          ),
        },
        {
          name: 'profile.displayName',
          label: tr('displayName'),
          span: { base: 'full', sm: 9, lg: 8 },
        },
      ],
    },
    radio: {
      span: { base: 'full', lg: 6 },
      icon: 'radio',
      fields: [
        {
          name: 'radio.volume',
          kind: 'rotary',
          span: { base: 'full', sm: 3 },
          props: {
            size: 'xs',
            showLabel: true,
            suffix: '%',
            disabled: !canControlRadio,
          },
        },
        {
          name: 'radio.stationId',
          label: tr('radioStation'),
          kind: 'select',
          props: { options: radioStations, disabled: !canControlRadio },
          span: { base: 'full', sm: 6 },
        },
        {
          name: 'radio.enabled',
          kind: 'switch',
          span: { base: 'full', md: 3 },
          props: {
            disabled: !canControlRadio,
            'aria-label': tr('radio'),
          },
        },
      ],
    },
    keyboardLighting: {
      show: values.keyboardLighting.show,
      span: { base: 'full' },
      icon: 'bulb',
      fields: [
        {
          name: 'integrations.keyboardLighting.enabled',
          kind: 'switch',
          label: tr('enabled'),
          span: { base: 'full', sm: 3 },
        },
        {
          name: 'integrations.keyboardLighting.mode',
          kind: 'select',
          label: tr('lightingMode'),
          span: { base: 'full', sm: 3 },
          props: {
            options: [
              { value: 'theme', label: tr('lightingThemeMode') },
              { value: 'music', label: tr('lightingMusicMode') },
            ],
          },
        },
        ...Object.entries({
          brightness: 'lightingBrightness',
          sensitivity: 'lightingSensitivity',
        }).map(([name, label]) => ({
          name: `integrations.keyboardLighting.${name}`,
          kind: 'slider' as const,
          label: tr(label),
          span: { base: 'full', sm: 3 } as const,
          props: { min: 0, max: 100 },
        })),
      ],
    },
    interfaceSettings: {
      span: { base: 'full' },
      icon: 'sliders',
      fields: [
        ...['headingFont', 'textFont'].map((name) => ({
          name: `interface.${name}`,
          kind: 'select' as const,
          label: tr(name),
          span: { base: 'full', sm: 4 } as const,
          props: { options: fontOptions },
        })),
        {
          name: 'interface.language',
          kind: 'select',
          label: tr('language'),
          span: { base: 'full', sm: 4 },
          props: {
            options: ['uk', 'ru', 'en'].map((value) => ({
              value,
              label: tr(`language.${value}`),
            })),
          },
        },
        ...Object.entries({
          'interface.reducedMotion': 'reduceAnimations',
          'integrations.discordPresence': 'discordPresence',
          'application.autoUpdate': 'autoUpdate',
        }).map(([name, label]) => ({
          name,
          kind: 'checkbox' as const,
          label: tr(label),
          span: { base: 'full', sm: 4 } as const,
        })),
      ],
    },
  } satisfies Record<string, FormBlock>;
};
