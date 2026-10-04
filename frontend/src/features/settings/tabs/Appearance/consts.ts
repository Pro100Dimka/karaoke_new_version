import { radioStations } from "../../../../app/radioStations";
import type { Language, ThemeName } from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";

export const langs = [
  { value: "uk", label: "Українська" },
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
] as const satisfies readonly { value: Language; label: string }[];

export const radioStationOptions = radioStations.map(({ id, name }) => ({
  value: id,
  label: name,
}));

/** The app's themes with their own colours for the theme gallery. */
export const themeOptions = [
  { value: "dark", label: "themeDark", description: "themeDarkDescription", color: "#ff3055" },
  { value: "light", label: "themeLight", description: "themeLightDescription", color: "#ffc783" },
  { value: "green", label: "themeGreen", description: "themeGreenDescription", color: "#20ffa0" },
  { value: "violet", label: "themeViolet", description: "themeVioletDescription", color: "#a74dff" },
] as const satisfies readonly { value: ThemeName; label: MessageKey; description: MessageKey; color: string }[];
