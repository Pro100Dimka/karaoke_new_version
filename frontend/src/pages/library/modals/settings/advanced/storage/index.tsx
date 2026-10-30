import { Button, Card, CollapsibleSection, DatabaseArt, KeyValueList, Stack, Typography, tr, useLocale } from "@neo-ui-kit/react";
import type { StorageUsageDto } from "../../../../../../contracts/models";
import type { MessageKey } from "../../../../../../i18n/messages";
import { ru } from "../../../../../../i18n/messages.ru";
import { formatBytes } from "../../../../../../shared/utils/format";
import { useStorageCleanup } from "./useStorageCleanup";

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
  useLocale();
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
      title={tr(ru.storage)}
      description={
        usage
          ? tr(ru.storageFree, { value: formatBytes(usage.free) })
          : tr(ru.unavailable)
      }
      actions={<DatabaseArt className="advancedArt" />}
    >
      {usage && (
        <Stack gap={4}>
          <Typography variant="caption" tone="muted">
            {tr(ru.storageUsed, {
              used: formatBytes(used),
            })}
          </Typography>
          <CollapsibleSection title={tr(ru.storageBreakdown)}>
            <KeyValueList
              items={parts.map(([key, label]) => [
                tr(ru[label]),
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
                {tr(ru[cleanup.label])}
              </Button>
            ))}
          </Stack>
        </Stack>
      )}
    </Card>
  );
};
