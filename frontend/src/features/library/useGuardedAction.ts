import { useNotify } from "../../app/NotificationsProvider";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";

/** Runs an action and reports a failure as a notification keyed by the stable error code. */
export const useGuardedAction = () => {
  const notify = useNotify();
  const t = useText();

  return async (action: () => Promise<void>, fallback: MessageKey = "actionFailed"): Promise<void> => {
    try {
      await action();
    } catch (failure) {
      notify(t(errorMessageKey(toAppError(failure)) ?? fallback), "error");
    }
  };
};
