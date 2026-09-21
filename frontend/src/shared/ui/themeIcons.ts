import type { ThemeName } from "../../contracts/models";
import dark from "../../assets/theme-icons/dark.png";
import green from "../../assets/theme-icons/green.png";
import light from "../../assets/theme-icons/light.png";
import violet from "../../assets/theme-icons/violet.png";

export const themeIcons = { dark, light, green, violet } as const satisfies Record<ThemeName, string>;
