import { queryOptions } from "@tanstack/react-query";
import { array, parse } from "valibot";
import { bridgedHttp } from "../services/desktopBridge";
import { jobsSchema, modelSchema, type AIModel, type JobProgress, type JobType } from "../utils/contracts";

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
