import { tr, useLocale } from "@neo-ui-kit/react";
import { useNotify } from "../../../providers/notifications";
import type { MessageKey } from "../../../i18n/messages";
import { ru } from "../../../i18n/messages.ru";
import { errorMessageKey, toAppError } from "../../../shared/errors";

/** Runs an action and reports a failure as a notification keyed by the stable error code. */
export const useGuardedAction = () => {
  const notify = useNotify();
  useLocale();

  return async (
    action: () => Promise<void>,
    fallback: MessageKey = "actionFailed",
  ): Promise<void> => {
    try {
      await action();
    } catch (failure) {
      notify(tr(ru[errorMessageKey(toAppError(failure)) ?? fallback]), "error");
    }
  };
};
