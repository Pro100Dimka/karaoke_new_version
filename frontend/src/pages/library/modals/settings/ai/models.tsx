import {
  Button,
  getLocale,
  Grid,
  StatusIndicator,
  tr,
} from '@neo-ui-kit/react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pythonClient } from '../../../../../services/pythonClient';
import {
  changeModel,
  modelKey,
  modelsQuery,
} from '../../../../../api/api-service';
import { useNotify } from '../../../../../providers/notifications';
import { ask } from '../../../../../providers/dialog';
import { useEffect } from 'react';
import { refreshOnJobChanges } from '../../../../../services/backendEvents';
import ModelCard from './model-card';

const Models = () => {
  const client = useQueryClient();
  const notify = useNotify();
  const pending = useIsMutating({ mutationKey: ['model-change'] }) > 0;
  const space = useQuery({ queryKey: ['model-free-space'], queryFn: () => pythonClient.freeStorageBytes('models'), refetchInterval: 5000 });
  const onError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error');
  useEffect(() => refreshOnJobChanges(() => {
    void client.invalidateQueries({ queryKey: ['models'] });
    void client.invalidateQueries({ queryKey: ['job', 'ModelDownload'] });
  }, 500), [client]);
  const { data: models, error, refetch } = useQuery(modelsQuery);
  const refresh = () =>
    Promise.all([
      refetch(),
      client.invalidateQueries({ queryKey: ['job', 'ModelDownload'] }),
    ]);
  const mutation = useMutation({
    mutationKey: ['model-change'],
    mutationFn: async (model: Parameters<typeof changeModel>[0]) => {
      if (model.state === 'Ready') {
        const choice = await ask({ title: tr('modelDelete'),
          body: tr('Удалить {name}? Песни и записи сохранятся. Модель можно будет скачать снова.', {name: model.modelId}),
          actions: [{id: 'cancel', label: tr('cancel')}, {id: 'delete', label: tr('modelDelete'), appearance: 'primary'}] });
        if (choice !== 'delete') return;
      } else {
        const free = await pythonClient.freeStorageBytes('models');
        client.setQueryData(['model-free-space'], free);
        if (free < model.requiredDiskBytes) throw new Error(tr('insufficientDiskTitle'));
      }
      return changeModel(model);
    },
    onSuccess: refresh,
    onError,
  });
  return (
    <>
      {error && (
        <Grid span="full">
          <Button
            icon="refresh"
            label={tr('modelProgressRetry')}
            onClick={() => {
              void refresh();
            }}
          />
        </Grid>
      )}
      {(error || !models) && (
        <Grid span="full">
          <StatusIndicator
            status={error ? 'error' : 'processing'}
            label={tr(error ? 'modelsLoadFailed' : 'modelsLoading')}
          />
        </Grid>
      )}
      {models?.map((model) => (
        <ModelCard
          key={modelKey(model)}
          model={model}
          locale={getLocale()}
          progressError={!!error}
          disabled={pending || !!error || (model.state !== 'Ready' && space.data != null && space.data < model.requiredDiskBytes)}
          pending={
            mutation.isPending &&
            modelKey(mutation.variables) === modelKey(model)
          }
          onAction={(model) => { if (!client.isMutating({ mutationKey: ['model-change'] })) mutation.mutate(model); }}
        />
      ))}
    </>
  );
};

export default Models;
