import type { ThemeName } from "../contracts/models";
import type { KeyboardLightingPreferences } from "../shared/preferences/preferences";
import { desktopClient } from "./desktopClient";

const themeColors = {
  dark: "FF173D",
  light: "FF365A",
  green: "35E39A",
  violet: "A95CFF",
} as const satisfies Record<ThemeName, string>;

export const keyboardLightingColor = (
  theme: ThemeName,
  mode: KeyboardLightingPreferences["mode"],
  positionSeconds = 0,
  sensitivity = 50,
): string => {
  if (mode === "theme") return themeColors[theme];
  const pulse = 0.45 + 0.55 * Math.abs(Math.sin(positionSeconds * Math.PI));
  const floor = 1 - Math.max(0, Math.min(100, sensitivity)) / 160;
  const intensity = Math.round(255 * Math.max(floor, pulse));
  return `${intensity.toString(16).padStart(2, "0")}1028`.toUpperCase();
};

export const keyboardLightingClient = {
  capabilities: () => desktopClient.keyboardLightingCapabilities(),
  apply(
    preferences: KeyboardLightingPreferences,
    theme: ThemeName,
    positionSeconds = 0,
  ): Promise<void> {
    return desktopClient.setKeyboardLighting({
      enabled: preferences.enabled,
      brightness: preferences.brightness,
      color: keyboardLightingColor(theme, preferences.mode, positionSeconds, preferences.sensitivity),
    });
  },
};
