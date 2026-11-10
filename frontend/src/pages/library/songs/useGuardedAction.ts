import { tr, useLocale } from '@neo-ui-kit/react';
import { useNotify } from '../../../providers/notifications';
import { errorstring, toAppError } from '../../../shared/errors';

/** Runs an action and reports a failure as a notification keyed by the stable error code. */
export const useGuardedAction = () => {
  const notify = useNotify();
  useLocale();

  return async (
    action: () => Promise<void>,
    fallback: string = 'actionFailed',
  ): Promise<void> => {
    try {
      await action();
    } catch (failure) {
      notify(tr(errorstring(toAppError(failure)) ?? fallback), 'error');
    }
  };
};
