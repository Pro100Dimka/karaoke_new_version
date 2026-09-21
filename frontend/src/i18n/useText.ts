import { useCallback } from "react";
import { useApp } from "../app/AppContext";
import { text, type MessageKey } from "./messages";

type MessageParams = Readonly<Record<string, string | number>>;

/** The returned function is stable per language so it is safe in hook dependency lists. */
export const useText = () => {
  const { language } = useApp();
  return useCallback((key: MessageKey, params?: MessageParams): string => text(language, key, params), [language]);
};
