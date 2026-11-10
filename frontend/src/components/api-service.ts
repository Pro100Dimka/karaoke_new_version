import { pythonClient } from '../services/pythonClient';
import type { ImportMetadata, ImportOptions } from '../contracts/clients';
import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { array, parse } from 'valibot';
import { bridgedHttp } from '../services/desktopBridge';
import {
  jobsSchema,
  modelSchema,
  type AIModel,
  type JobProgress,
  type JobType,
} from '../utils/contracts';
import type { SongDto, SongSearch } from '../contracts/models';
import {
  backendPollInterval,
  readBackendSnapshot,
} from '../services/backendEvents';

export const refreshSongs = async (client: QueryClient) => {
  await client.cancelQueries({ queryKey: ['songs'] });
  await Promise.all([
    client.invalidateQueries({ queryKey: ['songs'] }),
    client.invalidateQueries({ queryKey: ['song-summary'] }),
  ]);
};

export type SongPage = Awaited<ReturnType<typeof pythonClient.searchSongs>>;

export const songsQuery = (epoch: number, filter?: SongSearch) =>
  infiniteQueryOptions({
    queryKey: ['songs', epoch, filter ?? null],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }): Promise<SongPage> =>
      readBackendSnapshot(
        async () =>
          filter
            ? pythonClient.searchSongs(filter, pageParam)
            : { items: await pythonClient.listSongs(), nextCursor: null },
        ['library.changed'],
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: filter ? 30_000 : Infinity,
    gcTime: filter ? 30_000 : undefined,
    refetchOnMount: 'always',
    refetchInterval: backendPollInterval(filter ? false : 15_000),
    refetchIntervalInBackground: true,
  });

export const songSummaryQuery = (epoch: number) =>
  queryOptions({
    queryKey: ['song-summary', epoch],
    queryFn: ({ signal }) =>
      readBackendSnapshot(
        () => pythonClient.songSummary(),
        ['library.changed'],
        signal,
      ),
    refetchInterval: backendPollInterval(15_000),
  });

/** Shows a picked file while it waits for its turn to import. */
export const queueSongImport = (client: QueryClient, path: string) => {
  const placeholderId = `import:${crypto.randomUUID()}`;
  const placeholder: SongDto = {
    id: placeholderId,
    title: path.split(/[\\/]/).pop() ?? path,
    artist: '',
    language: 'Auto',
    status: 'importing',
    progress: 0,
    stage: 'Queued',
    durationSeconds: 0,
    createdAt: new Date().toISOString(),
    coverState: 'Fallback',
    activeRevision: 0,
    projectFormatVersion: 1,
  };
  client.setQueryData<readonly SongDto[]>(['song-imports'], (items) => [
    placeholder,
    ...(items ?? []),
  ]);
  return placeholderId;
};

export const importSong = async (
  client: QueryClient,
  path: string,
  metadata?: ImportMetadata,
  options?: ImportOptions,
  placeholderId = queueSongImport(client, path),
) => {
  const setImports = (
    update: (items: readonly SongDto[]) => readonly SongDto[],
  ) =>
    client.setQueryData<readonly SongDto[]>(['song-imports'], (items) =>
      update(items ?? []),
    );
  try {
    const song = await pythonClient.importSong(path, metadata, {
      ...options,
      onProgress: (value) => {
        options?.onProgress(value);
        setImports((current) =>
          current.map((item) =>
            item.id === placeholderId
              ? {
                  ...item,
                  progress: value.progress,
                  stage: value.stage,
                  jobId: value.jobId,
                }
              : item,
          ),
        );
      },
    });
    await client.cancelQueries({ queryKey: ['songs'] });
    client.setQueriesData<InfiniteData<SongPage>>(
      { queryKey: ['songs'] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page, index) => ({
            ...page,
            items: [
              ...(index === 0 ? [song] : []),
              ...page.items.filter((item) => item.id !== song.id),
            ],
          })),
        },
    );
    setImports((current) =>
      current.filter((item) => item.id !== placeholderId),
    );
    await refreshSongs(client);
    return song;
  } finally {
    setImports((current) =>
      current.filter((item) => item.id !== placeholderId),
    );
  }
};

export const modelKey = ({ modelId, version }: AIModel) =>
  `${modelId}:${version}`;
export const isModelBusy = ({ state }: AIModel) =>
  ['Downloading', 'Verifying'].includes(state);
export const isActiveJob = (job?: JobProgress | null) =>
  !!job && ['Queued', 'Running', 'Cancelling'].includes(job.state);

const modelListQuery = (catalogOnly: boolean) =>
  queryOptions({
    queryKey: catalogOnly ? ['models', 'required'] : ['models'],
    queryFn: ({ signal }) =>
      readBackendSnapshot(
        async () => {
          const models = await bridgedHttp(
            'pythonRequest',
            {
              method: 'GET',
              path: catalogOnly ? '/models?catalog_only=true' : '/models',
            },
            'Models request failed',
          );
          signal.throwIfAborted();
          return parse(array(modelSchema), models);
        },
        ['models.changed'],
        signal,
      ),
    refetchInterval: backendPollInterval(5000),
  });

export const modelsQuery = modelListQuery(false);
export const requiredModelsQuery = modelListQuery(true);

export const processingSettingsQuery = queryOptions({
  queryKey: ['processing-settings'],
  queryFn: async ({ signal }) => {
    const settings = await pythonClient.getAiProcessingSettings();
    signal.throwIfAborted();
    return settings;
  },
  staleTime: Infinity,
  refetchOnMount: 'always',
});

export const jobQuery = (type: JobType, entityId: string) =>
  queryOptions({
    queryKey: ['job', type, entityId],
    queryFn: ({ signal }) =>
      readBackendSnapshot(
        async () => {
          const result = await bridgedHttp(
            'pythonRequest',
            {
              method: 'GET',
              path: `/jobs?type=${type}&entityId=${encodeURIComponent(entityId)}&limit=1`,
            },
            'Job request failed',
          );
          signal.throwIfAborted();
          return parse(jobsSchema, result).items[0] ?? null;
        },
        ['job.changed'],
        signal,
      ),
    refetchInterval: backendPollInterval(1000),
  });

export const changeModel = (model: AIModel) =>
  bridgedHttp(
    'pythonRequest',
    {
      method: model.state === 'Ready' ? 'DELETE' : 'POST',
      path: `/models/${encodeURIComponent(model.modelId)}/${encodeURIComponent(model.version)}${model.state === 'Ready' ? '' : '/download'}`,
    },
    'Model update failed',
  );
