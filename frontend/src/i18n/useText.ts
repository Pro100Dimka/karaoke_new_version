import { useCallback } from "react";
import { useApp } from "../app/AppContext";
import { text, type MessageKey } from "./messages";
import { unverifiedAsioMonitoring } from "../contracts/models";

type MessageParams = Readonly<Record<string, string | number>>;
export type ITranslate = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

export const monitoringErrorText = (error: unknown, t: ITranslate): string =>
  error instanceof Error && error.message === unverifiedAsioMonitoring
    ? t("monitoringAsio4AllBlocked")
    : error instanceof Error ? error.message : String(error);
/** The returned function is stable per language so it is safe in hook dependency lists. */
export const useText = () => {
  const { language } = useApp("language");
  return useCallback(
    (key: MessageKey, params?: MessageParams): string =>
      text(language, key, params),
    [language],
  );
};
