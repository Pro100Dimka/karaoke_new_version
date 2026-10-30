import { tr } from "@neo-ui-kit/react";
import { ru } from "../../i18n/messages.ru";
import type { DialogRequest } from "../../providers/dialog";
import { formatBytes } from "../../shared/utils/format";
import { minimumRecordingBytes } from "../../application/karaoke/KaraokeRecordingCoordinator";

type Ask = (request: DialogRequest) => Promise<string | null>;
/** One shared "not enough disk" prompt; resolves to the chosen action id. */
export const askInsufficientDisk = (
  ask: Ask,
  availableBytes: number,
): Promise<string | null> =>
  ask({
    title: tr(ru.insufficientDiskTitle),
    body: tr(ru.insufficientDisk, {
      required: formatBytes(minimumRecordingBytes),
      available: formatBytes(availableBytes),
    }),
    actions: [
      { id: "close", label: tr(ru.close) },
      { id: "storage", label: tr(ru.openStorageSettings), appearance: "primary" },
    ],
  });
