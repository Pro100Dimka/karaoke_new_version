import {
  Card,
  Checkbox,
  FilePicker,
  Grid,
  RotaryKnob,
  Select,
  Slider,
  Switch,
  TextField,
  ThemePicker,
  themes,
  tr,
} from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../../providers/store';
import { appThemes } from '../../../../../providers/theme/variants';
import { fonts } from '../../../../../utils/consts';
import { radioStations, youtubeSource } from '../../../../../app/radioStations';
import {
  parsePreferences,
  type Preferences,
} from '../../../../../shared/preferences/preferences';
import {
  setRadioStation,
  setRadioVolume,
  toggleRadio,
} from '../../../../../providers/radio';
import type { useKeyboardLighting } from './keyboardlighting/useKeyboardLighting';

export const AppearanceFields = observer(
  ({
    photo,
    canChangePhoto,
    changePhoto,
    lighting,
  }: {
    photo: string;
    canChangePhoto: boolean;
    changePhoto(file: File): Promise<void>;
    lighting: ReturnType<typeof useKeyboardLighting>;
  }) => {
    const p = store.preferences;
    const radio = store.radio;
    const update = <K extends keyof Preferences>(key: K, value: unknown) => {
      const parsed = parsePreferences({ ...store.preferences, [key]: value });
      store.updatePreferences({
        [key]: parsed[key],
        ...(key === 'reducedMotion' ? { animationQualitySelected: true } : {}),
      });
    };
    const updateLighting = <K extends keyof Preferences['keyboardLighting']>(
      key: K,
      value: Preferences['keyboardLighting'][K],
    ) => {
      lighting.update(
        parsePreferences({
          ...store.preferences,
          keyboardLighting: {
            ...store.preferences.keyboardLighting,
            [key]: value,
          },
        }).keyboardLighting,
      );
    };
    const fontOptions = Object.entries(fonts).map(([value, [label, font]]) => ({
      value,
      font,
      label: tr(label),
    }));
    return (
      <Grid columns={12} gap={3} className="appearanceLayout">
        <Grid span={{ base: 'full', md: 3, lg: 4 }}>
          <Card
            className="appearanceThemes"
            border
            title={tr('theme')}
            icon="palette"
            style={{ background: 'transparent' }}
          >
            <Grid
              columns={12}
              gap={3}
              align="center"
              className="ad-form-fields"
            >
              <Grid span="full" className="ad-form-field">
                <ThemePicker
                  label={tr('theme')}
                  value={p.theme}
                  onValueChange={(value) => update('theme', value)}
                  options={Object.entries(appThemes).map(
                    ([value, { preview, library }]) => ({
                      value,
                      label: tr(value),
                      ...preview,
                      color: themes[library][0],
                    }),
                  )}
                />
              </Grid>
            </Grid>
          </Card>
        </Grid>
        <Grid span={{ base: 'full', md: 9, lg: 8 }}>
          <Grid columns={12} gap={3} className="appearanceDetails">
            <Grid span={{ base: 'full', md: 6 }}>
              <Card
                border
                title={tr('profile')}
                icon="profile"
                style={{ height: '100%', background: 'transparent' }}
              >
                <Grid
                  columns={12}
                  gap={3}
                  align="center"
                  className="ad-form-fields"
                >
                  <Grid
                    span={{ base: 'full', sm: 3, lg: 4 }}
                    className="ad-form-field"
                    data-custom=""
                  >
                    <FilePicker
                      variant="avatar"
                      accept="image/*"
                      disabled={!canChangePhoto}
                      src={photo}
                      name={p.displayName}
                      onFiles={(files) => {
                        if (files[0]) void changePhoto(files[0]);
                      }}
                    />
                  </Grid>
                  <Grid
                    span={{ base: 'full', sm: 9, lg: 8 }}
                    className="ad-form-field"
                  >
                    <TextField
                      label={tr('displayName')}
                      value={p.displayName}
                      onValueChange={(value) =>
                        update('displayName', value.slice(0, 48))
                      }
                    />
                  </Grid>
                </Grid>
              </Card>
            </Grid>
            <Grid span={{ base: 'full', md: 6 }}>
              <Card
                border
                title={tr('radio')}
                icon="radio"
                style={{ height: '100%', background: 'transparent' }}
              >
                <Grid
                  columns={12}
                  gap={3}
                  align="center"
                  className="ad-form-fields"
                >
                  <Grid
                    span={{ base: 'full', sm: 3 }}
                    className="ad-form-field"
                  >
                    <RotaryKnob
                      size="xs"
                      showLabel
                      suffix="%"
                      disabled={!radio.canControl}
                      value={radio.volume}
                      onValueChange={setRadioVolume}
                    />
                  </Grid>
                  <Grid
                    span={{ base: 'full', sm: 6 }}
                    className="ad-form-field"
                  >
                    <Select
                      label={tr('radioStation')}
                      value={radio.stationId}
                      options={[
                        ...radioStations.map(({ id, name }) => ({
                          value: id,
                          label: name,
                        })),
                        ...(youtubeSource(radio.stationId)
                          ? [
                              {
                                value: radio.stationId,
                                label:
                                  radio.youtubeTrack?.playlistTitle ??
                                  'YouTube',
                              },
                            ]
                          : []),
                      ]}
                      disabled={!radio.canControl}
                      onValueChange={setRadioStation}
                    />
                  </Grid>
                  <Grid
                    span={{ base: 'full', md: 3 }}
                    className="ad-form-field"
                  >
                    <Switch
                      aria-label={tr('radio')}
                      checked={radio.enabled}
                      disabled={!radio.canControl}
                      onValueChange={(value) => {
                        if (value !== radio.enabled) toggleRadio();
                      }}
                    />
                  </Grid>
                </Grid>
              </Card>
            </Grid>
            {lighting.capabilities?.available && (
              <Grid span="full">
                <Card
                  border
                  title={tr('keyboardLighting')}
                  icon="bulb"
                  style={{ height: '100%', background: 'transparent' }}
                >
                  <Grid
                    columns={12}
                    gap={3}
                    align="center"
                    className="ad-form-fields"
                  >
                    <Grid
                      span={{ base: 'full', sm: 3 }}
                      className="ad-form-field"
                    >
                      <Switch
                        label={tr('enabled')}
                        checked={p.keyboardLighting.enabled}
                        onValueChange={(value) =>
                          updateLighting('enabled', value)
                        }
                      />
                    </Grid>
                    <Grid
                      span={{ base: 'full', sm: 3 }}
                      className="ad-form-field"
                    >
                      <Select
                        label={tr('lightingMode')}
                        value={p.keyboardLighting.mode}
                        options={(
                          [
                            { value: 'theme', label: 'lightingThemeMode' },
                            { value: 'music', label: 'lightingMusicMode' },
                          ] as const
                        ).map(({ value, label }) => ({
                          value,
                          label: tr(label),
                        }))}
                        onValueChange={(value) => updateLighting('mode', value)}
                      />
                    </Grid>
                    {(
                      [
                        { key: 'brightness', label: 'lightingBrightness' },
                        { key: 'sensitivity', label: 'lightingSensitivity' },
                      ] as const
                    ).map(({ key, label }) => (
                      <Grid
                        key={key}
                        span={{ base: 'full', sm: 3 }}
                        className="ad-form-field"
                      >
                        <Slider
                          label={tr(label)}
                          min={0}
                          max={100}
                          value={p.keyboardLighting[key]}
                          onValueChange={(value) => updateLighting(key, value)}
                        />
                      </Grid>
                    ))}
                  </Grid>
                </Card>
              </Grid>
            )}
            <Grid span="full">
              <Card
                border
                title={tr('interfaceSettings')}
                icon="sliders"
                style={{ height: '100%', background: 'transparent' }}
              >
                <Grid
                  columns={12}
                  gap={3}
                  align="center"
                  className="ad-form-fields"
                >
                  {(['headingFont', 'textFont'] as const).map((key) => (
                    <Grid
                      key={key}
                      span={{ base: 'full', sm: 4 }}
                      className="ad-form-field"
                    >
                      <Select
                        label={tr(key)}
                        value={p[key]}
                        options={fontOptions}
                        onValueChange={(value) => update(key, value)}
                      />
                    </Grid>
                  ))}
                  <Grid
                    span={{ base: 'full', sm: 6 }}
                    className="ad-form-field"
                  >
                    <Select
                      label={tr('karaokeLyricsLayout')}
                      value={p.karaokeLyricsLayout}
                      options={(
                        ['classic', 'credits', 'alternating'] as const
                      ).map((value) => ({
                        value,
                        label: tr(`karaokeLyricsLayout.${value}`),
                      }))}
                      onValueChange={(value) =>
                        update('karaokeLyricsLayout', value)
                      }
                    />
                  </Grid>
                  <Grid
                    span={{ base: 'full', sm: 6 }}
                    className="ad-form-field"
                  >
                    <Select
                      label={tr('karaokeLyricsLines')}
                      value={
                        p.karaokeLyricsLayout === 'alternating'
                          ? 2
                          : p.karaokeLyricsLines
                      }
                      disabled={p.karaokeLyricsLayout === 'alternating'}
                      options={[1, 2, 3, 4].map((value) => ({
                        value,
                        label: String(value),
                      }))}
                      onValueChange={(value) =>
                        update('karaokeLyricsLines', value)
                      }
                    />
                  </Grid>
                  <Grid
                    span={{ base: 'full', sm: 4 }}
                    className="ad-form-field"
                  >
                    <Select
                      label={tr('language')}
                      value={p.language}
                      options={(['uk', 'ru', 'en'] as const).map((value) => ({
                        value,
                        label: tr(`language.${value}`),
                      }))}
                      onValueChange={(value) => update('language', value)}
                    />
                  </Grid>
                  {(
                    [
                      { key: 'reducedMotion', label: 'reduceAnimations' },
                      { key: 'discordPresence', label: 'discordPresence' },
                      { key: 'autoUpdate', label: 'autoUpdate' },
                    ] as const
                  ).map(({ key, label }) => (
                    <Grid
                      key={key}
                      span={{ base: 'full', sm: 4 }}
                      className="ad-form-field"
                    >
                      <Checkbox
                        label={tr(label)}
                        checked={p[key]}
                        onValueChange={(value) => update(key, value)}
                      />
                    </Grid>
                  ))}
                </Grid>
              </Card>
            </Grid>
          </Grid>
        </Grid>
      </Grid>
    );
  },
);
