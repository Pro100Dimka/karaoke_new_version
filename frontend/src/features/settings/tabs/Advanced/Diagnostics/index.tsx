import { useEffect, useState } from "react";
import { Button, Card, KeyValueList, StatusIndicator } from "@ad-voice/ui";
import { useNotify } from "../../../../../app/NotificationsProvider";
import type { BackendDiagnosticsDto } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { desktopClient } from "../../../../../services/desktopClient";
import type { SubsystemHealth } from "../useSubsystemHealth";
import { frontendVersion } from "../About";
import { buildDiagnosticsReport } from "./diagnosticsReport";

type Level = "success" | "warning" | "error";

const backendLevel = (backend: BackendDiagnosticsDto | null): Level => {
  if (!backend) return "error";
  return backend.state === "Ready" ? "success" : "warning";
};
const audioLevel = (audio: Readonly<Record<string, string>> | null): Level => {
  if (!audio) return "error";
  return audio.LastFailureCode && audio.LastFailureCode !== "None" ? "warning" : "success";
};

/** Health of every subsystem at a glance, with the report to copy or save for support. */
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
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const report = () => buildDiagnosticsReport({
    frontendVersion,
    generatedAt: new Date().toISOString(),
    backend,
    audio,
    keyboardLighting: lighting.available,
  });
  const copy = async () => {
    await desktopClient.copyText(report());
    notify(t("copied"), "success");
  };
  const exportReport = async () => {
    if (await desktopClient.saveTextFile("ad-voice-diagnostics.json", report())) notify(t("reportExported"), "success");
  };

  const rows: { label: string; level: Level; value: string }[] = [
    { label: t("pythonBackend"), level: backendLevel(backend), value: backend ? backend.state : t("unavailable") },
    ...(backend ? [
      { label: t("database"), level: backend.database ? "success" : "error", value: t(backend.database ? "healthy" : "unhealthy") },
      { label: t("aiRuntime"), level: backend.cudaAvailable ? "success" : "warning", value: backend.gpuName ?? "CPU" },
      { label: "FFmpeg", level: backend.ffmpegVersion ? "success" : "warning", value: backend.ffmpegVersion ?? t("unavailable") },
    ] satisfies typeof rows : []),
    { label: t("audioServiceLabel"), level: audioLevel(audio), value: audio ? (audio.ServiceState ?? "") : t("unavailable") },
    ...(audio ? [
      { label: t("audioXruns"), level: "success", value: `${audio.XRuns ?? "0"} / ${audio.DeadlineMisses ?? "0"}` },
    ] satisfies typeof rows : []),
    {
      label: t("keyboardLighting"),
      level: lighting.available ? "success" : "warning",
      value: lighting.available
        ? t("keyboardLightingStatus", { provider: lighting.provider ?? "OpenRGB", count: lighting.deviceCount })
        : t("keyboardLightingUnsupported"),
    },
  ];

  return (
    <Card border className="advancedDiagnosticsCard" icon="stethoscope" title={t("diagnostics")} description={t("diagnosticsHint")}>
      <div className="settingsStack">
        <KeyValueList items={rows.map(row => [row.label, <StatusIndicator key={row.label} status={row.level} label={row.value} />])} />
        <div className="advancedActions">
          <Button size="sm" icon="copy" onClick={() => void copy()}>{t("copyDiagnostics")}</Button>
          <Button size="sm" icon="download" onClick={() => void exportReport()}>{t("exportDiagnostics")}</Button>
          <Button size="sm" variant="ghost" icon="refresh" onClick={health.refresh}>{t("refresh")}</Button>
        </div>
      </div>
    </Card>
  );
};
