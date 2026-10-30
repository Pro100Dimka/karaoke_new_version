import { tr, useLocale } from "@neo-ui-kit/react";
import { useCallback, useState } from "react";
import { useNotify } from "../../providers/notifications";
import { ru } from "../../i18n/messages.ru";
import { errorMessageKey, toAppError } from "../../shared/errors";

/** Runs one friends action at a time: controls wait while it runs, and a failure is shown. */
export const useSocialAction = () => {
  const notify = useNotify();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        if (done) notify(done, "success");
        return true;
      } catch (error) {
        notify(
          tr(ru[errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"]),
          "error",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notify, locale],
  );
  return { busy, run };
};
