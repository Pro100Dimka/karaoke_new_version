import { tr, useLocale } from '@neo-ui-kit/react';
import { useRef, useState } from 'react';
import { ask } from '../../../../../../providers/dialog';
import { useNotify } from '../../../../../../providers/notifications';
import { pythonClient as backend } from '../../../../../../services/pythonClient';
import { errorstring, toAppError } from '../../../../../../shared/errors';

type CleanupKind = 'cache' | 'temp';

/** Confirmation and cleanup share one lock, including while a dialog is pending. */
export const useStorageCleanup = (onChanged: () => void) => {
  const notify = useNotify();
  useLocale();
  const [cleaning, setCleaning] = useState<CleanupKind | null>(null);
  const inFlight = useRef(false);

  const clean = async (kind: CleanupKind) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCleaning(kind);
    try {
      const choice = await ask({
        title: tr(kind === 'cache' ? 'clearCache' : 'removeTemporaryFiles'),
        body: tr(kind === 'temp' ? 'cleanupTemporaryBody' : 'cleanupBody'),
        actions: [
          { id: 'cancel', label: tr('cancel') },
          { id: 'confirm', label: tr('confirm'), appearance: 'primary' },
        ],
      });
      if (choice !== 'confirm') return;
      const removed = await (kind === 'cache'
        ? backend.clearCache()
        : backend.clearTemporaryFiles());
      if (removed) notify(tr('cleanupDone'), 'success');
      else notify(tr('cleanupNothingRemoved'), 'info');
      onChanged();
    } catch (error) {
      const failure = toAppError(error);
      notify(
        tr(
          failure.code === 'StorageInUse'
            ? 'errorStorageInUse'
            : (errorstring(failure) ?? 'cleanupFailed'),
        ),
        'error',
      );
    } finally {
      inFlight.current = false;
      setCleaning(null);
    }
  };

  return { cleaning, clean };
};
