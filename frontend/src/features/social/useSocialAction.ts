import { tr, useLocale } from '@neo-ui-kit/react';
import { useCallback, useRef, useState } from 'react';
import { useNotify } from '../../providers/notifications';
import { errorstring, toAppError } from '../../shared/errors';

/** Runs one friends action at a time: controls wait while it runs, and a failure is shown. */
export const useSocialAction = () => {
  const notify = useNotify();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string): Promise<boolean> => {
      if (pending.current) return false;
      pending.current = true;
      setBusy(true);
      try {
        await action();
        if (done) notify(done, 'success');
        return true;
      } catch (error) {
        notify(
          tr(errorstring(toAppError(error)) ?? 'roomNetworkUnavailable'),
          'error',
        );
        return false;
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [notify, locale],
  );
  return { busy, run };
};
