import type { ModelDto, ModelState } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";

export const modelStateLabel = {
  "not-installed": "modelNotInstalled",
  downloading: "modelDownloading",
  ready: "modelReady",
  failed: "modelFailed",
  "update-available": "modelUpdateAvailable"
} as const satisfies Record<ModelState, MessageKey>;

/** Disk space required for a download: the payload plus an equally sized temporary copy and a 10% margin. */
export const requiredDiskBytes = (model: ModelDto): number => Math.ceil(model.sizeBytes * 2.1);

export const canDownload = (model: ModelDto): boolean =>
  model.state === "not-installed" || model.state === "failed" || model.state === "update-available";
