import { radioStations } from "../../../../app/radioStations";
import type { Language } from "../../../../contracts/models";

export const langs = [
  { value: "uk", label: "Українська" },
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
] as const satisfies readonly { value: Language; label: string }[];

export const radioStationOptions = radioStations.map(({ id, name }) => ({
  value: id,
  label: name,
}));
