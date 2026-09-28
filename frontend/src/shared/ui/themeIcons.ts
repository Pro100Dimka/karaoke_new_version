import type { ThemeName } from "../../contracts/models";
import dark from "../../assets/theme-icons/dark.png";
import green from "../../assets/theme-icons/green.png";
import light from "../../assets/theme-icons/light.png";
import violet from "../../assets/theme-icons/violet.png";

export const themeIcons = { dark, light, green, violet } as const satisfies Record<ThemeName, string>;

export const themeIconMotionColors = {
  dark: { primary: "#ff153f", highlight: "#ffe0d6" },
  light: { primary: "#e31d63", highlight: "#fff2dc" },
  green: { primary: "#2fff8d", highlight: "#dffff0" },
  violet: { primary: "#b85cff", highlight: "#fff0ff" },
} as const satisfies Record<ThemeName, { primary: string; highlight: string }>;
