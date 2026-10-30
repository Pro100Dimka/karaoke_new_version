import { Button, Grid, MessageBar, ProgressBar, tr } from '@neo-ui-kit/react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNotify } from '../../../../../providers/notifications';
import { desktopClient } from '../../../../../services/desktopClient';
import { pythonClient } from '../../../../../services/pythonClient';
import type { SettingsPanelProps } from '../../../../../utils/contracts';
import FormCards from '../form-cards';
import Models from './models';
import { blocks } from './rows';

const AIPanel = ({ form }: SettingsPanelProps) => {
  const notify = useNotify();
  const client = useQueryClient();
  const choosingFolder = useIsMutating({ mutationKey: ['storage-root'] }) > 0;
  const transferring = useIsMutating({ mutationKey: ['library-transfer'] }) > 0;
  const [progress, setProgress] = useState(0);
  const onError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error');
  const folder = useMutation({
    mutationKey: ['storage-root'],
    mutationFn: async () => {
      if (desktopClient.fixedStorageRoot) return;
      const path = await desktopClient.pickStorageFolder();
      if (path) await desktopClient.setStorageRoot(path);
      return path;
    },
    onSuccess: (path) => { if (path) form.setValue('ai.transferToLibraryPath', path); },
    onError,
  });
  const transfer = useMutation({
    mutationKey: ['library-transfer'],
    mutationFn: async (file?: File) => {
      setProgress(0);
      const update = (job: { progress: number }) => setProgress(job.progress);
      if (!file) await desktopClient.revealInExplorer(await pythonClient.exportLibrary(update));
      else {
        const path = desktopClient.pathForFile(file);
        if (!path) throw new Error(tr('libraryTransferFailed'));
        const result = await pythonClient.importLibrary(path, update);
        notify(tr('libraryImported', result), 'success');
      }
    },
    onError,
  });
  return (
    <FormCards blocks={blocks(form,
      () => { if (!client.isMutating({ mutationKey: ['storage-root'] })) folder.mutate(); },
      choosingFolder || Boolean(desktopClient.fixedStorageRoot),
      () => { if (!client.isMutating({ mutationKey: ['library-transfer'] })) transfer.mutate(undefined); },
      (file) => { if (!client.isMutating({ mutationKey: ['library-transfer'] })) transfer.mutate(file); }, transferring)}>
      {form.values.ai.error && <Grid span="full"><MessageBar tone="error"
        action={<Button label={tr('retry')} onClick={() => form.setValue('ai.retry', true)} />}>
        {form.values.ai.error}
      </MessageBar></Grid>}
      {transferring && <ProgressBar style={{gridColumn: '1 / -1'}} value={progress}
        indeterminate={!transfer.isPending} label={tr('libraryArchiveHint')} />}
      {form.values.ai.backend === 'Local' && <Models />}
    </FormCards>
  );
};
export default AIPanel;
