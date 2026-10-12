import type { ThemeName as LibraryTheme } from "@neo-ui-kit/react";
import type { ThemeName } from "../contracts/models";
import darkBackground from "../assets/karaoke-backgrounds/dark.webp";
import greenBackground from "../assets/karaoke-backgrounds/green.webp";
import lightBackground from "../assets/karaoke-backgrounds/light.webp";
import violetBackground from "../assets/karaoke-backgrounds/violet.webp";
import darkIcon from "../assets/theme-icons/dark.png";
import greenIcon from "../assets/theme-icons/green.png";
import lightIcon from "../assets/theme-icons/light.png";
import violetIcon from "../assets/theme-icons/violet.png";

/** Each app theme is a Neo UI theme (all colours come from it) plus the app's own space picture and icon. */
export const appThemes = {
  dark: { library: "ruby", background: darkBackground, icon: darkIcon },
  light: { library: "light", background: lightBackground, icon: lightIcon },
  green: { library: "green", background: greenBackground, icon: greenIcon },
  violet: { library: "violet", background: violetBackground, icon: violetIcon },
} as const satisfies Record<
  ThemeName,
  { library: LibraryTheme; background: string; icon: string }
>;
