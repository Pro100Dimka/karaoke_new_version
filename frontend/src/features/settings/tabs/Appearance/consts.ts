import { radioStations } from "../../../../app/radioStations";
import type { Language, ThemeName } from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import type { AppFont } from "../../../../shared/preferences/appFonts";

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
  {
    value: "dark",
    label: "themeDark",
    description: "themeDarkDescription",
    color: "#ff3055",
  },
  {
    value: "light",
    label: "themeLight",
    description: "themeLightDescription",
    color: "#ffc783",
  },
  {
    value: "green",
    label: "themeGreen",
    description: "themeGreenDescription",
    color: "#20ffa0",
  },
  {
    value: "violet",
    label: "themeViolet",
    description: "themeVioletDescription",
    color: "#a74dff",
  },
] as const satisfies readonly {
  value: ThemeName;
  label: MessageKey;
  description: MessageKey;
  color: string;
}[];

/** Faces offered for titles and for text, in the order they are listed (see shared/preferences/appFonts). */
export const fontOptions = [
  { value: "melodix", label: "fontMelodix" },
  { value: "melodixText", label: "fontMelodixText" },
  { value: "segoe", label: "fontSegoe" },
  { value: "humanist", label: "fontHumanist" },
  { value: "serif", label: "fontSerif" },
  { value: "mono", label: "fontMono" },
] as const satisfies readonly { value: AppFont; label: MessageKey }[];
