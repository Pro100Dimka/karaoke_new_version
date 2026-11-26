import {
  Button,
  Card,
  Grid,
  IconButton,
  MessageBar,
  Select,
  TextField,
  tr,
} from '@neo-ui-kit/react';
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { processingSettingsQuery } from '../../../../../components/api-service';
import { useNotify } from '../../../../../providers/notifications';
import { desktopClient } from '../../../../../services/desktopClient';
import { pythonClient } from '../../../../../services/pythonClient';
import Models from './models';
import { LibraryArchive } from './rows';

const AIPanel = () => {
  const notify = useNotify();
  const client = useQueryClient();
  const savingBackend =
    useIsMutating({ mutationKey: ['processing-settings'] }) > 0;
  const processing = useQuery({
    ...processingSettingsQuery,
    enabled: !savingBackend,
  });
  const storageRoot = useQuery({
    queryKey: ['storage-root'],
    queryFn: async ({ signal }) => {
      const root = await desktopClient.getStorageRoot();
      signal.throwIfAborted();
      return root;
    },
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
  const saveBackend = useMutation({
    mutationKey: ['processing-settings'],
    onMutate: () => client.cancelQueries({ queryKey: ['processing-settings'] }),
    mutationFn: (processingBackend: 'Local' | 'Oracle') =>
      pythonClient.updateAiProcessingSettings({ processingBackend }),
    onSuccess: (settings) =>
      client.setQueryData(['processing-settings'], settings),
    onError: async (error) => {
      notify(error.message, 'error');
      await client.invalidateQueries({ queryKey: ['processing-settings'] });
    },
  });
  const choosingFolder = useIsMutating({ mutationKey: ['storage-root'] }) > 0;
  const onError = (error: unknown) =>
    notify(error instanceof Error ? error.message : String(error), 'error');
  const folder = useMutation({
    mutationKey: ['storage-root'],
    mutationFn: async () => {
      if (desktopClient.fixedStorageRoot) return;
      const path = await desktopClient.pickStorageFolder();
      if (path) await desktopClient.setStorageRoot(path);
      return path;
    },
    onSuccess: async (path) => {
      if (!path) return;
      await client.cancelQueries({ queryKey: ['storage-root'] });
      client.setQueryData(['storage-root'], path);
    },
    onError,
  });
  return (
    <Grid columns={12} gap={3} style={{ height: '100%' }}>
      <Grid span="full">
        <Card
          border
          title={tr('processing')}
          icon="chip"
          style={{ height: '100%', background: 'transparent' }}
        >
          <Grid columns={12} gap={3} align="center" className="ad-form-fields">
            <Grid span={{ base: 'full', sm: 6 }} className="ad-form-field">
              <Select
                label={tr('aiProcessingBackend')}
                value={processing.data?.processingBackend ?? 'Local'}
                disabled={savingBackend || !processing.data}
                options={(
                  [
                    { value: 'Local', label: 'aiBackendLocal' },
                    { value: 'Oracle', label: 'aiBackendOracle' },
                  ] as const
                ).map(({ value, label }) => ({ value, label: tr(label) }))}
                onValueChange={(backend) => {
                  const selected = (['Local', 'Oracle'] as const).find(
                    (value) => value === backend,
                  );
                  if (
                    selected &&
                    !client.isMutating({ mutationKey: ['processing-settings'] })
                  )
                    saveBackend.mutate(selected);
                }}
              />
            </Grid>
            <Grid span={{ base: 'full', sm: 6 }} className="ad-form-field">
              <TextField
                label={tr('transferToLibraryPath')}
                value={storageRoot.data ?? ''}
                disabled
                endAdornment={
                  <IconButton
                    size="xs"
                    icon="folder"
                    label={tr('selectFolder')}
                    disabled={
                      choosingFolder || Boolean(desktopClient.fixedStorageRoot)
                    }
                    onClick={() => {
                      if (!client.isMutating({ mutationKey: ['storage-root'] }))
                        folder.mutate();
                    }}
                  />
                }
              />
            </Grid>
          </Grid>
          <MessageBar
            action={
              <Button
                label={tr('legalDocuments')}
                onClick={() => void desktopClient.showLegalDocuments?.()}
              />
            }
          >
            {tr('legalRemoteNotice')}
          </MessageBar>
        </Card>
      </Grid>
      <LibraryArchive />
      {(processing.error?.message ?? storageRoot.error?.message) && (
        <Grid span="full">
          <MessageBar
            tone="error"
            action={
              <Button
                label={tr('retry')}
                onClick={() => {
                  void client.invalidateQueries({
                    queryKey: ['processing-settings'],
                  });
                  void client.invalidateQueries({
                    queryKey: ['storage-root'],
                  });
                }}
              />
            }
          >
            {processing.error?.message ?? storageRoot.error?.message}
          </MessageBar>
        </Grid>
      )}
      {(processing.data?.processingBackend ?? 'Local') === 'Local' && (
        <Models />
      )}
    </Grid>
  );
};
export default AIPanel;
