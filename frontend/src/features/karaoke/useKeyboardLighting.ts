import { useEffect } from "react";
import type { ThemeName } from "../../contracts/models";
import { keyboardLightingClient } from "../../services/keyboardLightingClient";
import type { KeyboardLightingPreferences } from "../../shared/preferences/preferences";

export const useKeyboardLighting = (
  preferences: KeyboardLightingPreferences,
  theme: ThemeName,
  positionSeconds: number,
  playing: boolean,
): void => {
  const frame = Math.floor(positionSeconds * 2) / 2;

  useEffect(() => {
    if (!preferences.enabled) return;
    const effective = preferences.mode === "music" && !playing
      ? { ...preferences, mode: "theme" as const }
      : preferences;
    void keyboardLightingClient.apply(effective, theme, frame).catch(() => undefined);
  }, [frame, playing, preferences, theme]);

  useEffect(() => () => {
    if (preferences.enabled && preferences.mode === "music") {
      void keyboardLightingClient.apply({ ...preferences, mode: "theme" }, theme).catch(() => undefined);
    }
  }, [preferences, theme]);
};
