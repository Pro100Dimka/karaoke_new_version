import { Button, FilePicker, IconButton, Stack, Grid, ProgressBar, tr } from '@neo-ui-kit/react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNotify } from '../../../../../providers/notifications';
import { desktopClient } from '../../../../../services/desktopClient';
import { pythonClient } from '../../../../../services/pythonClient';
import FormCard from '../form-cards/card';
import type { FormBlock, SettingsFormValues } from '../../../../../utils/contracts';

export const blocks = (
  values: Pick<SettingsFormValues, "ai">,
  chooseFolder: () => void,
  choosingFolder: boolean,
) =>
  ({
    processing: {
      span: { base: 'full' },
      icon: 'chip',
      fields: [
        {
          name: 'ai.backend',
          kind: 'select',
          label: tr('aiProcessingBackend'),
          span: { base: 'full', sm: 6 },
          props: {
            disabled: values.ai.savingBackend,
            options: [
              { value: 'Local', label: tr('aiBackendLocal') },
              { value: 'Kaggle', label: tr('aiBackendKaggle') },
            ],
          },
        },
        {
          name: 'ai.transferToLibraryPath',
          label: tr('transferToLibraryPath'),
          span: { base: 'full', sm: 6 },
          props: {
            disabled: true,
            endAdornment: (
              <IconButton
                size="xs"
                icon="folder"
                label={tr('selectFolder')}
                disabled={choosingFolder}
                onClick={chooseFolder}
              />
            ),
          },
        },
      ],
    },
  }) satisfies Record<string, FormBlock>;

export const LibraryArchive = () => {
  const client = useQueryClient();
  const notify = useNotify();
  const transferring = useIsMutating({ mutationKey: ['library-transfer'] }) > 0;
  const [progress, setProgress] = useState(0);
  const onError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error');
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
  const transferFile = (file?: File) => {
    if (!client.isMutating({ mutationKey: ['library-transfer'] })) transfer.mutate(file);
  };
  return (<>
    <Grid span="full">
      <FormCard title={tr('importExport')} icon="chip" description={tr('libraryArchiveHint')}>
        <Stack direction="row" gap={2} wrap>
          <Button icon="download" disabled={transferring} onClick={() => transferFile()}
            style={{ flex: 1 }} label={tr('libraryExport')} />
          <FilePicker className="library-import-picker" icon="upload" label={tr('libraryImport')}
            style={{ flex: 1, width: '100%' }} accept=".zip" disabled={transferring}
            onFiles={files => { if (files[0]) transferFile(files[0]); }} />
        </Stack>
      </FormCard>
    </Grid>
    {transferring && <ProgressBar style={{ gridColumn: '1 / -1' }} value={progress}
      indeterminate={!transfer.isPending} label={tr('libraryArchiveHint')} />}
  </>);
};
