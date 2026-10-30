import { Form, Button, Grid, MessageBar, tr } from '@neo-ui-kit/react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../../../../providers/notifications';
import { desktopClient } from '../../../../../services/desktopClient';
import { pythonClient } from '../../../../../services/pythonClient';
import useSettingsForm from '../form';
import FormCards from '../form-cards';
import Models from './models';
import { blocks, LibraryArchive } from './rows';

const AIPanel = () => {
  const notify = useNotify();
  const client = useQueryClient();
  const savingBackend = useIsMutating({ mutationKey: ["processing-settings"] }) > 0;
  const processing = useQuery({ queryKey: ["processing-settings"],
    queryFn: async ({ signal }) => {
      const settings = await pythonClient.getAiProcessingSettings();
      signal.throwIfAborted();
      return settings;
    }, enabled: !savingBackend, staleTime: Infinity, refetchOnMount: "always" });
  const storageRoot = useQuery({ queryKey: ["storage-root"],
    queryFn: async ({ signal }) => {
      const root = await desktopClient.getStorageRoot();
      signal.throwIfAborted();
      return root;
    }, staleTime: Infinity, refetchOnMount: "always" });
  const saveBackend = useMutation({
    mutationKey: ["processing-settings"],
    onMutate: () => client.cancelQueries({ queryKey: ["processing-settings"] }),
    mutationFn: (processingBackend: "Local" | "Kaggle") => pythonClient.updateAiProcessingSettings({ processingBackend }),
    onSuccess: (settings) => client.setQueryData(["processing-settings"], settings),
    onError: async (error) => {
      notify(error.message, "error");
      await client.invalidateQueries({ queryKey: ["processing-settings"] });
    },
  });
  const form = useSettingsForm({ ai: {
    backend: processing.data?.processingBackend ?? "Local", transferToLibraryPath: storageRoot.data ?? "",
    savingBackend: savingBackend || !processing.data,
    error: processing.error?.message ?? storageRoot.error?.message ?? "",
  } }, (path, value) => {
    if (path !== "ai.backend") return;
    const backend = (["Local", "Kaggle"] as const).find(item => item === value);
    if (backend && !client.isMutating({ mutationKey: ["processing-settings"] })) saveBackend.mutate(backend);
  });
  const choosingFolder = useIsMutating({ mutationKey: ['storage-root'] }) > 0;
  const onError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error');
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
    <Form form={form}><FormCards blocks={blocks(form.values,
      () => { if (!client.isMutating({ mutationKey: ['storage-root'] })) folder.mutate(); },
      choosingFolder || Boolean(desktopClient.fixedStorageRoot))}>
      <LibraryArchive />
      {form.values.ai.error && <Grid span="full"><MessageBar tone="error"
        action={<Button label={tr('retry')} onClick={() => {
          void client.invalidateQueries({ queryKey: ['processing-settings'] });
          void client.invalidateQueries({ queryKey: ['storage-root'] });
        }} />}>
        {form.values.ai.error}
      </MessageBar></Grid>}
      {form.values.ai.backend === 'Local' && <Models />}
    </FormCards></Form>
  );
};
export default AIPanel;
