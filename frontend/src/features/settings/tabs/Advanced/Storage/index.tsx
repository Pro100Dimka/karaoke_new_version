import {
  Button,
  Card,
  DatabaseArt,
  KeyValueList,
  ProgressBar,
  Stack,
  Typography,
} from "@ad-voice/ui";
import { useAsk } from "../../../../../app/DialogProvider";
import { useNotify } from "../../../../../app/NotificationsProvider";
import type { StorageUsageDto } from "../../../../../contracts/models";
import type { MessageKey } from "../../../../../i18n/messages";
import { useText } from "../../../../../i18n/useText";
import { pythonClient } from "../../../../../services/pythonClient";
import { formatBytes } from "../../../../../shared/utils/format";

const parts = [
  ["songs", "storageSongs"],
  ["models", "storageModels"],
  ["cache", "storageCache"],
  ["recordings", "storageRecordings"],
  ["temp", "storageTemp"],
] as const satisfies readonly (readonly [keyof StorageUsageDto, MessageKey])[];

const cleanups = [
  {
    kind: "cache",
    label: "clearCache",
    icon: "trash",
    run: () => pythonClient.clearCache(),
  },
  {
    kind: "temp",
    label: "removeTemporaryFiles",
    icon: "history",
    run: () => pythonClient.clearTemporaryFiles(),
  },
] as const;
type Cleanup = (typeof cleanups)[number];

/** Disk usage by kind, with confirmed cleanup of the cache and temporary files. */
export const StoragePanel = ({
  usage,
  onChanged,
}: {
  usage: StorageUsageDto | null;
  onChanged(): void;
}) => {
  const t = useText();
  const ask = useAsk();
  const notify = useNotify();

  const clean = async (cleanup: Cleanup) => {
    const choice = await ask({
      title: t(cleanup.label),
      body: t("cleanupBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "confirm", label: t("confirm"), appearance: "primary" },
      ],
    });
    if (choice !== "confirm") return;
    try {
      await cleanup.run();
      notify(t("cleanupDone"), "success");
      onChanged();
    } catch {
      notify(t("cleanupFailed"), "error");
    }
  };

  const used = usage
    ? parts.reduce((total, [key]) => total + usage[key], 0)
    : 0;
  const total = usage ? usage.free + used : 0;

  return (
    <Card
      border
      className="advancedStorageCard"
      icon="database"
      title={t("storage")}
      description={
        usage
          ? t("storageFree", { value: formatBytes(usage.free) })
          : t("unavailable")
      }
      actions={<DatabaseArt className="advancedArt" />}
    >
      {usage && (
        <div className="settingsStack">
          <Stack gap={2}>
            <Typography variant="caption" tone="muted">
              {t("storageUsed", {
                used: formatBytes(used),
                total: formatBytes(total),
              })}
            </Typography>
            <ProgressBar
              label={t("storage")}
              value={used}
              max={Math.max(1, total)}
            />
          </Stack>
          <KeyValueList
            items={parts.map(([key, label]) => [
              t(label),
              formatBytes(usage[key]),
            ])}
          />
          <Stack direction="row" gap={3} wrap>
            {cleanups.map((cleanup) => (
              <Button
                key={cleanup.kind}
                size="sm"
                icon={cleanup.icon}
                onClick={() => void clean(cleanup)}
              >
                {t(cleanup.label)}
              </Button>
            ))}
          </Stack>
        </div>
      )}
    </Card>
  );
};
