import { Button } from "../../theme/ui";
import { AlertTriangle, CheckCircle2, CircleAlert, Stethoscope, type LucideIcon } from "lucide-react";
import { useNotify } from "../../app/NotificationsProvider";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { SettingsCard } from "./SettingsCard";
import { buildDiagnosticsReport } from "./diagnosticsReport";
import type { SubsystemHealth } from "./useSubsystemHealth";
import { frontendVersion } from "./version";
import { useEffect, useState } from "react";

type Level = "healthy" | "unhealthy" | "warning";

const levelIcon = {
  healthy: CheckCircle2,
  unhealthy: CircleAlert,
  warning: AlertTriangle
} as const satisfies Record<Level, LucideIcon>;

const Row = ({ level, label, value }: { level: Level; label: string; value: string }) => {
  const Icon = levelIcon[level];
  return (
    <li className={`healthRow health-${level}`}>
      <Icon aria-hidden size={16} />
      <strong>{label}</strong>
      <span>{value}</span>
    </li>
  );
};

export const DiagnosticsPanel = ({ health }: { health: SubsystemHealth }) => {
  const t = useText();
  const notify = useNotify();
  const { backend, audio } = health;
  const [lighting, setLighting] = useState<KeyboardLightingCapabilities>({ available: false, deviceCount: 0 });
  useEffect(() => {
    let active = true;
    const refresh = () => void desktopClient.keyboardLightingCapabilities().then(value => active && setLighting(value));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const report = () =>
    buildDiagnosticsReport({
      frontendVersion,
      generatedAt: new Date().toISOString(),
      backend,
      audio,
      keyboardLighting: lighting.available
    });

  const handleCopy = async () => {
    await desktopClient.copyText(report());
    notify(t("copied"), "success");
  };
  const handleExport = async () => {
    if (await desktopClient.saveTextFile("ad-voice-diagnostics.json", report())) notify(t("reportExported"), "success");
  };

  const backendLevel: Level = !backend ? "unhealthy" : backend.state === "Ready" ? "healthy" : "warning";
  const audioLevel: Level = !audio ? "unhealthy" : audio.LastFailureCode && audio.LastFailureCode !== "None" ? "warning" : "healthy";

  return (
    <SettingsCard icon={Stethoscope} title={t("diagnostics")} description={t("diagnosticsHint")}>
      <ul className="healthList">
        <Row level={backendLevel} label={t("pythonBackend")} value={backend ? backend.state : t("unavailable")} />
        {backend && (
          <Row
            level={backend.database ? "healthy" : "unhealthy"}
            label={t("database")}
            value={backend.database ? t("healthy") : t("unhealthy")}
          />
        )}
        {backend && (
          <Row
            level={backend.cudaAvailable ? "healthy" : "warning"}
            label={t("aiRuntime")}
            value={backend.gpuName ?? "CPU"}
          />
        )}
        {backend && (
          <Row
            level={backend.ffmpegVersion ? "healthy" : "warning"}
            label="FFmpeg"
            value={backend.ffmpegVersion ?? t("unavailable")}
          />
        )}
        <Row level={audioLevel} label={t("audioServiceLabel")} value={audio ? (audio.ServiceState ?? "") : t("unavailable")} />
        {audio && <Row level="healthy" label={t("audioXruns")} value={`${audio.XRuns ?? "0"} / ${audio.DeadlineMisses ?? "0"}`} />}
        <Row
          level={lighting.available ? "healthy" : "warning"}
          label={t("keyboardLighting")}
          value={lighting.available
            ? t("keyboardLightingStatus", { provider: lighting.provider ?? "OpenRGB", count: lighting.deviceCount })
            : t("keyboardLightingUnsupported")}
        />
      </ul>
      <div className="settingsSectionActions">
        <Button size="sm" variant="outlined" tone="neutral" onClick={() => void handleCopy()}>
          {t("copyDiagnostics")}
        </Button>
        <Button size="sm" variant="outlined" tone="neutral" onClick={() => void handleExport()}>
          {t("exportDiagnostics")}
        </Button>
        <Button size="sm" variant="outlined" tone="neutral" onClick={health.refresh}>
          {t("refresh")}
        </Button>
      </div>
    </SettingsCard>
  );
};
