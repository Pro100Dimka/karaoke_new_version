import { Button } from "../../theme/ui";
import { Database } from "lucide-react";
import { useNotify } from "../../app/NotificationsProvider";
import { useAsk } from "../../app/DialogProvider";
import type { StorageUsageDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { formatBytes } from "../../shared/utils/format";
import { SettingsCard } from "./SettingsCard";

const rows = [
  ["songs", "storageSongs"],
  ["models", "storageModels"],
  ["cache", "storageCache"],
  ["recordings", "storageRecordings"],
  ["temp", "storageTemp"]
] as const satisfies readonly (readonly [keyof StorageUsageDto, MessageKey])[];

export const StoragePanel = ({ usage, onChanged }: { usage: StorageUsageDto | null; onChanged(): void }) => {
  const t = useText();
  const ask = useAsk();
  const notify = useNotify();

  const clean = async (kind: "cache" | "temp") => {
    const choice = await ask({
      title: t(kind === "cache" ? "clearCache" : "removeTemporaryFiles"),
      body: t("cleanupBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "confirm", label: t("confirm"), appearance: "primary" }
      ]
    });
    if (choice !== "confirm") return;
    try {
      await (kind === "cache" ? pythonClient.clearCache() : pythonClient.clearTemporaryFiles());
      notify(t("cleanupDone"), "success");
      onChanged();
    } catch {
      notify(t("cleanupFailed"), "error");
    }
  };

  if (!usage) {
    return <SettingsCard icon={Database} title={t("storage")} description={t("unavailable")} />;
  }

  return (
    <SettingsCard icon={Database} title={t("storage")} description={t("storageFree", { value: formatBytes(usage.free) })}>
      <dl className="usageList">
        {rows.map(([key, label]) => (
          <div key={key}>
            <dt>{t(label)}</dt>
            <dd>{formatBytes(usage[key])}</dd>
          </div>
        ))}
      </dl>
      <div className="settingsSectionActions">
        <Button size="sm" variant="outlined" tone="neutral" onClick={() => void clean("cache")}>
          {t("clearCache")}
        </Button>
        <Button size="sm" variant="outlined" tone="neutral" onClick={() => void clean("temp")}>
          {t("removeTemporaryFiles")}
        </Button>
      </div>
    </SettingsCard>
  );
};
