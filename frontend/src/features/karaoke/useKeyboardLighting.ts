import { observeOperation } from '../../shared/errors';
import { keyboardLightingClient } from '../../services/keyboardLightingClient';
import { useEffect } from 'react';
import { reaction } from 'mobx';
import type { ThemeName } from '../../contracts/models';
import type { KeyboardLightingPreferences } from '../../shared/preferences/preferences';

export const useKeyboardLighting = (
  preferences: KeyboardLightingPreferences,
  theme: ThemeName,
  positionSeconds: number | (() => number),
  playing: boolean,
): void => {
  const position =
    typeof positionSeconds === 'number'
      ? Math.floor(positionSeconds * 2) / 2
      : positionSeconds;
  useEffect(() => {
    if (!preferences.enabled) return;
    const effective =
      preferences.mode === 'music' && !playing
        ? { ...preferences, mode: 'theme' as const }
        : preferences;
    return reaction(
      () =>
        typeof position === 'function'
          ? Math.floor(position() * 2) / 2
          : position,
      (frame) => {
        void observeOperation(
          'errors.lighting',
          keyboardLightingClient.apply(effective, theme, frame),
        ).catch(() => undefined);
      },
      { fireImmediately: true },
    );
  }, [position, playing, preferences, theme]);

  useEffect(
    () => () => {
      if (preferences.enabled && preferences.mode === 'music') {
        void keyboardLightingClient
          .apply({ ...preferences, mode: 'theme' }, theme)
          .catch(() => undefined);
      }
    },
    [preferences, theme],
  );
};
