import type { ThemeName } from "../../contracts/models";
import dark from "../../assets/karaoke-backgrounds/dark.webp";
import green from "../../assets/karaoke-backgrounds/green.webp";
import light from "../../assets/karaoke-backgrounds/light.webp";
import violet from "../../assets/karaoke-backgrounds/violet.webp";

export const sceneBackgrounds = { dark, light, green, violet } as const satisfies Record<ThemeName, string>;
