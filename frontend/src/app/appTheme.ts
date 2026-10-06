import type { ThemeName as LibraryTheme } from "@ad-voice/ui";
import { themes } from "@ad-voice/ui";
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

/** A colour moved toward black (amount < 0) or white (amount > 0), as #rrggbb. */
const shade = (hex: string, amount: number): string => {
  const target = amount < 0 ? 0 : 255;
  const channels = [1, 3, 5].map((index) =>
    parseInt(hex.slice(index, index + 2), 16),
  );
  return `#${channels
    .map((value) =>
      Math.round(value + (target - value) * Math.abs(amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/** The animated backdrop's colours, from the same theme pair as every Neo UI surface. */
export const backdropColors = (theme: ThemeName) => {
  const [primary, secondary] = themes[appThemes[theme].library];
  return {
    primary,
    primaryHover: secondary,
    secondary: shade(primary, -0.4),
    accent: shade(primary, 0.2),
    highlight: shade(secondary, 0.75),
  };
};
