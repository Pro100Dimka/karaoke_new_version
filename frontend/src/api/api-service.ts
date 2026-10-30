import { pythonClient } from "../services/pythonClient";
import type { ImportMetadata, ImportOptions } from "../contracts/clients";
import { queryOptions, type QueryClient, type InfiniteData } from "@tanstack/react-query";
import { array, parse } from "valibot";
import { bridgedHttp } from "../services/desktopBridge";
import { jobsSchema, modelSchema, type AIModel, type JobProgress, type JobType } from "../utils/contracts";
import type { SongDto } from "../contracts/models";

export const refreshSongs = async (client: QueryClient) => {
  await client.cancelQueries({ queryKey: ["songs"] });
  client.setQueriesData<InfiniteData<{ items: readonly SongDto[]; nextCursor: string | null }>>(
    { queryKey: ["songs"] }, data => data && ({ ...data,
      pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }));
  await Promise.all([
    client.invalidateQueries({ queryKey: ["songs"] }),
    client.invalidateQueries({ queryKey: ["song-summary"] }),
  ]);
};

type SongPage = Awaited<ReturnType<typeof pythonClient.searchSongs>>;

export const importSong = async (
    client: QueryClient,
    path: string,
    metadata?: ImportMetadata,
    options?: ImportOptions,
  ) => {
    const setImports = (update: (items: readonly SongDto[]) => readonly SongDto[]) =>
      client.setQueryData<readonly SongDto[]>(["song-imports"], items => update(items ?? []));
    const placeholderId = `import:${crypto.randomUUID()}`;
    const placeholder: SongDto = {
      id: placeholderId,
      title: path.split(/[\\/]/).pop() ?? path,
      artist: "",
      language: "Auto",
      status: "importing",
      progress: 0,
      stage: "Queued",
      durationSeconds: 0,
      createdAt: new Date().toISOString(),
      coverState: "Fallback",
      activeRevision: 0,
      projectFormatVersion: 1,
    };
    setImports((current) => [placeholder, ...current]);
    try {
      const song = await pythonClient.importSong(
        path,
        metadata,
        {
          ...options,
          onProgress: (value) => {
            options?.onProgress(value);
            setImports((current) => current.map((item) => item.id === placeholderId
              ? { ...item, progress: value.progress, stage: value.stage, jobId: value.jobId }
              : item));
          },
        },
      );
      await client.cancelQueries({ queryKey: ["songs"] });
      client.setQueriesData<InfiniteData<SongPage>>({ queryKey: ["songs"] }, (data) => data && ({ ...data,
        pages: data.pages.map((page, index) => ({ ...page, items: [
          ...(index === 0 ? [song] : []), ...page.items.filter((item) => item.id !== song.id),
        ] })) }));
      setImports((current) => current.filter((item) => item.id !== placeholderId));
      await refreshSongs(client);
      return song;
    } finally {
      setImports((current) => current.filter((item) => item.id !== placeholderId));
    }
  };


export const modelKey = ({ modelId, version }: AIModel) => `${modelId}:${version}`;
export const isModelBusy = ({ state }: AIModel) => ["Downloading", "Verifying"].includes(state);
export const isActiveJob = (job?: JobProgress | null) => !!job && ["Queued", "Running", "Cancelling"].includes(job.state);

export const modelsQuery = queryOptions({
  queryKey: ["models"],
  queryFn: async ({ signal }) => {
    const models = await bridgedHttp("pythonRequest", { method: "GET", path: "/models" }, "Models request failed");
    signal.throwIfAborted();
    return parse(array(modelSchema), models);
  },
  refetchInterval: 5000,
});

export const jobQuery = (type: JobType, entityId: string) => queryOptions({
  queryKey: ["job", type, entityId],
  queryFn: async ({ signal }) => {
    const result = await bridgedHttp("pythonRequest", {
      method: "GET", path: `/jobs?type=${type}&entityId=${encodeURIComponent(entityId)}&limit=1`,
    }, "Job request failed");
    signal.throwIfAborted();
    return parse(jobsSchema, result).items[0] ?? null;
  },
  refetchInterval: 1000,
});

export const changeModel = (model: AIModel) => bridgedHttp("pythonRequest", {
  method: model.state === "Ready" ? "DELETE" : "POST",
  path: `/models/${encodeURIComponent(model.modelId)}/${encodeURIComponent(model.version)}${model.state === "Ready" ? "" : "/download"}`,
}, "Model update failed");
