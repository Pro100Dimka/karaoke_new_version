import { observeOperation } from '../shared/errors';
import { observer } from 'mobx-react-lite';
import { store } from '../providers/store';
import { tr, useLocale } from '@neo-ui-kit/react';
import { useEffect, useRef } from 'react';
import { useNotify } from '../providers/notifications';

import { hasEditorDraft } from '../pages/editor/editorDraft';
import { pythonClient } from '../services/pythonClient';

/** Once per launch, surfaces items left unresolved by a previous crash; nothing is auto-resumed. */
export const StartupRecovery = observer(() => {
  const { python } = store.application.services;
  const notify = useNotify();
  const locale = useLocale();
  const done = useRef(false);

  useEffect(() => {
    if (python.kind !== 'ready' || done.current) return;
    done.current = true;
    void observeOperation(
      'errors.recovery',
      pythonClient.listJobs().then((jobs) => {
        if (jobs.some((job) => job.state === 'interrupted'))
          notify(tr('recoveryInterruptedJobs'), 'warning');
      }),
    ).catch(() => undefined);
    if (hasEditorDraft()) notify(tr('recoveryEditorDraft'), 'warning');
  }, [python.kind, notify, locale]);

  return null;
});
