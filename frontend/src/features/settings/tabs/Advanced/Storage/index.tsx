import { Database, FileAudio, History, Music2, PackageOpen, Trash2, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { useAsk } from "../../../../../app/DialogProvider";
import { useNotify } from "../../../../../app/NotificationsProvider";
import type { StorageUsageDto } from "../../../../../contracts/models";
import type { MessageKey } from "../../../../../i18n/messages";
import { useText } from "../../../../../i18n/useText";
import { pythonClient } from "../../../../../services/pythonClient";
import { formatBytes } from "../../../../../shared/utils/format";
import { Button } from "../../../../../theme/ui";
import { SettingsCard } from "../../../SettingsCard";

const rows = [
  ["songs", "storageSongs", Music2],
  ["models", "storageModels", PackageOpen],
  ["cache", "storageCache", Database],
  ["recordings", "storageRecordings", FileAudio],
  ["temp", "storageTemp", History],
] as const satisfies readonly (readonly [keyof StorageUsageDto, MessageKey, LucideIcon])[];

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

  const clean = async (kind: "cache" | "temp") => {
    const choice = await ask({
      title: t(kind === "cache" ? "clearCache" : "removeTemporaryFiles"),
      body: t("cleanupBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "confirm", label: t("confirm"), appearance: "primary" },
      ],
    });
    if (choice !== "confirm") return;
    try {
      await (kind === "cache"
        ? pythonClient.clearCache()
        : pythonClient.clearTemporaryFiles());
      notify(t("cleanupDone"), "success");
      onChanged();
    } catch {
      notify(t("cleanupFailed"), "error");
    }
  };

  if (!usage) {
    return (
      <SettingsCard className="advancedStorageCard" frameOrder={1}
        icon={Database}
        title={t("storage")}
        description={t("unavailable")}
      />
    );
  }
  const used = rows.reduce((total, [key]) => total + usage[key], 0);
  const total = usage.free + used;

  return (
    <SettingsCard className="advancedStorageCard" frameOrder={1}
      icon={Database}
      title={t("storage")}
      description={t("storageFree", { value: formatBytes(usage.free) })}
    >
      <div className="storageMeter">
        <div className="storageMeta">
          <span>{t("storageFree", { value: formatBytes(usage.free) })}</span>
          <span>{t("storageUsed", { used: formatBytes(used), total: formatBytes(total) })}</span>
        </div>
        <div className="storageTrack" role="progressbar" aria-label={t("storage")} aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={used}>
          <span className="storageFill" style={{ width: `${Math.min(100, used / Math.max(1, total) * 100)}%` }} />
        </div>
      </div>
      <dl className="usageList storageList">
        {rows.map(([key, label, Icon]) => (
          <div key={key}>
            <Icon aria-hidden />
            <dt>{t(label)}</dt>
            <dd>{formatBytes(usage[key])}</dd>
          </div>
        ))}
      </dl>
      <div className="settingsSectionActions storageActions">
        <Button
          size="sm"
          variant="outlined"
          tone="neutral"
          onClick={() => void clean("cache")}
        >
          <Trash2 aria-hidden />
          {t("clearCache")}
        </Button>
        <Button
          size="sm"
          variant="outlined"
          tone="neutral"
          onClick={() => void clean("temp")}
        >
          <History aria-hidden />
          {t("removeTemporaryFiles")}
        </Button>
      </div>
      <svg className="databaseArt" viewBox="0 0 170 179" fill="none" aria-hidden="true">
        <defs>
          <filter id="settings-db-bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
          <linearGradient id="settings-db-body"><stop stopColor="#9a1636" /><stop offset=".12" stopColor="#3b0313" /><stop offset=".3" stopColor="#19050d" /><stop offset=".72" stopColor="#090408" /><stop offset="1" stopColor="#5e071e" /></linearGradient>
          <radialGradient id="settings-db-top" cx=".3" cy=".27" r=".9"><stop stopColor="#a72649" /><stop offset=".23" stopColor="#38111d" /><stop offset=".66" stopColor="#10040a" /><stop offset="1" stopColor="#290610" /></radialGradient>
          <linearGradient id="settings-db-edge"><stop stopColor="#fff1e9" /><stop offset=".16" stopColor="#ff6388" /><stop offset=".47" stopColor="#8b0730" /><stop offset=".8" stopColor="#ff285f" /><stop offset="1" stopColor="#ffabbc" /></linearGradient>
          <radialGradient id="settings-db-aura"><stop stopColor="#fd1746" stopOpacity=".3" /><stop offset=".5" stopColor="#ff083c" stopOpacity=".12" /><stop offset="1" stopColor="#ff083c" stopOpacity="0" /></radialGradient>
          <g id="settings-db-spark"><path d="M-7 0H7M0-8V8" stroke="#ffafbc" strokeWidth=".7" /><circle r="3.4" fill="#ff4264" filter="url(#settings-db-bloom)" /><circle r="1.4" fill="#fff1eb" /></g>
        </defs>
        <ellipse cx="85" cy="120" rx="83" ry="71" fill="url(#settings-db-aura)" />
        <g transform="translate(0 2)">
          <path d="M39 57V133C39 156 134 156 134 133V57Z" fill="url(#settings-db-body)" stroke="#ff345b" strokeWidth=".75" />
          <path d="M39 83C39 106 134 106 134 83M39 108C39 132 134 132 134 108M39 133C39 155 134 155 134 133" stroke="#ff335d" strokeWidth="3.5" opacity=".7" filter="url(#settings-db-bloom)" />
          <path d="M39 83C39 106 134 106 134 83M39 108C39 132 134 132 134 108M39 133C39 155 134 155 134 133" stroke="url(#settings-db-edge)" strokeWidth="1.4" />
          <ellipse cx="86.5" cy="57" rx="47.5" ry="17" fill="url(#settings-db-top)" stroke="#ff426b" strokeWidth="1.1" />
          <ellipse cx="86.5" cy="57" rx="47.5" ry="17" stroke="#ff2b57" strokeWidth="5" opacity=".75" filter="url(#settings-db-bloom)" />
          <ellipse cx="86.5" cy="57" rx="42" ry="13.8" stroke="url(#settings-db-edge)" strokeWidth=".5" opacity=".8" />
          <ellipse cx="86.5" cy="81" rx="47.5" ry="17" stroke="#e4264f" strokeWidth=".7" opacity=".75" />
          <ellipse cx="86.5" cy="106" rx="47.5" ry="17" stroke="#e4264f" strokeWidth=".7" opacity=".8" />
          <ellipse cx="86.5" cy="132" rx="47.5" ry="17" stroke="#e4264f" strokeWidth=".7" opacity=".7" />
          <g stroke="#ffe7ed" strokeWidth="1.45">
            <ellipse className="databaseOrbit" cx="86.5" cy="57" rx="47.5" ry="17" pathLength="100" />
            <ellipse className="databaseOrbit databaseOrbitTwo" cx="86.5" cy="106" rx="47.5" ry="17" pathLength="100" />
            <ellipse className="databaseOrbit databaseOrbitThree" cx="86.5" cy="132" rx="47.5" ry="17" pathLength="100" />
          </g>
          <ellipse cx="86.5" cy="53.5" rx="5" ry="1.6" fill="#ff577b" filter="url(#settings-db-bloom)" /><ellipse cx="86.5" cy="53.5" rx="3.4" ry=".8" fill="#ffb5c3" />
        </g>
        {[[42,84,1,-1],[44,111,1,-2.7],[132,143,1,-.6],[15,135,.75,-2],[64,151,.8,-3],[156,147,.75,-1.5]].map(([x,y,scale,delay]) => (
          <g key={`${x}-${y}`} className="databaseSparkle" style={{ "--delay": `${delay}s` } as CSSProperties}><use href="#settings-db-spark" transform={`translate(${x} ${y}) scale(${scale})`} /></g>
        ))}
      </svg>
    </SettingsCard>
  );
};
