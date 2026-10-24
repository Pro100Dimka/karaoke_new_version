import {
  Button,
  Card,
  CollapsibleSection,
  DatabaseArt,
  KeyValueList,
  Stack,
  Typography,
} from "@neo-ui-kit/react";
import type { StorageUsageDto } from "../../../../../contracts/models";
import type { MessageKey } from "../../../../../i18n/messages";
import { useText } from "../../../../../i18n/useText";
import { formatBytes } from "../../../../../shared/utils/format";
import { useStorageCleanup } from "./hooks/useStorageCleanup";

const parts = [
  ["songs", "storageSongs"],
  ["models", "storageModels"],
  ["cache", "storageCache"],
  ["recordings", "storageRecordings"],
  ["temp", "storageTemp"],
] as const satisfies readonly (readonly [keyof StorageUsageDto, MessageKey])[];

const cleanups = [
  { kind: "cache", label: "clearCache", icon: "trash" },
  {
    kind: "temp",
    label: "removeTemporaryFiles",
    icon: "history",
  },
] as const;

/** Disk usage by kind, with confirmed cleanup of the cache and temporary files. */
export const StoragePanel = ({
  usage,
  onChanged,
}: {
  usage: StorageUsageDto | null;
  onChanged(): void;
}) => {
  const t = useText();
  const { cleaning, clean } = useStorageCleanup(onChanged);

  const used = usage
    ? parts.reduce((total, [key]) => total + usage[key], 0)
    : 0;

  return (
    <Card
      border
      className="advancedStorageCard"
      style={{
        background: "unset!important",
        boxShadow: "unset!important",
        height: "100%",
      }}
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
          <Typography variant="caption" tone="muted">
            {t("storageUsed", {
              used: formatBytes(used),
            })}
          </Typography>
          <CollapsibleSection title={t("storageBreakdown")}>
            <KeyValueList
              items={parts.map(([key, label]) => [
                t(label),
                formatBytes(usage[key]),
              ])}
            />
          </CollapsibleSection>
          <Stack direction="row" gap={2} wrap>
            {cleanups.map((cleanup) => (
              <Button
                key={cleanup.kind}
                size="sm"
                icon={cleanup.icon}
                disabled={cleaning !== null}
                loading={cleaning === cleanup.kind}
                onClick={() => void clean(cleanup.kind)}
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
