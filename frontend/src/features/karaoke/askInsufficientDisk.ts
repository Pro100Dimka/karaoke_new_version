import type { DialogRequest } from "../../app/DialogProvider";
import type { MessageKey } from "../../i18n/messages";
import { formatBytes } from "../../shared/utils/format";

export const minimumRecordingBytes = 200 * 1024 * 1024;

type Ask = (request: DialogRequest) => Promise<string | null>;
type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** One shared "not enough disk" prompt; resolves to the chosen action id. */
export const askInsufficientDisk = (ask: Ask, t: Translate, availableBytes: number): Promise<string | null> =>
  ask({
    title: t("insufficientDiskTitle"),
    body: t("insufficientDisk", {
      required: formatBytes(minimumRecordingBytes),
      available: formatBytes(availableBytes)
    }),
    actions: [
      { id: "close", label: t("close") },
      { id: "storage", label: t("openStorageSettings"), appearance: "primary" }
    ]
  });
