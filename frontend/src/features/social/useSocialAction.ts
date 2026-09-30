import { useCallback, useState } from "react";
import { useNotify } from "../../app/NotificationsProvider";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";

/** Runs one friends action at a time: controls wait while it runs, and a failure is shown. */
export const useSocialAction = () => {
  const notify = useNotify();
  const t = useText();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      if (done) notify(done, "success");
      return true;
    } catch (error) {
      notify(t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }, [notify, t]);
  return { busy, run };
};
