import type { SelectOption } from "./types";

export const optionItem = (option: SelectOption | string | number): SelectOption =>
  typeof option === "object" ? option : { value: option, label: String(option) };
