import {
  Button,
  Card,
  CollapsibleSection,
  IconButton,
  KeyValueList,
  Stack,
  StatusIndicator,
} from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import { useNotify } from "../../../../../app/NotificationsProvider";
import type { BackendDiagnosticsDto } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import {
  useSettingsBackend,
  useSettingsDesktop,
} from "../../../SettingsProvider";
import { frontendVersion } from "../About";
import type { SubsystemHealth } from "../useSubsystemHealth";
import { buildDiagnosticsReport } from "./diagnosticsReport";

type Level = "success" | "warning" | "error";

const backendStates = [
  "Starting",
  "Ready",
  "Degraded",
  "Stopping",
  "Failed",
] as const;
const isBackendState = (
  state: string,
): state is (typeof backendStates)[number] =>
  (backendStates as readonly string[]).includes(state);

const backendLevel = (backend: BackendDiagnosticsDto | null): Level => {
  if (!backend) return "error";
  return backend.state === "Ready" ? "success" : "warning";
};
const audioLevel = (audio: Readonly<Record<string, string>> | null): Level => {
  if (!audio) return "error";
  return audio.LastFailureCode && audio.LastFailureCode !== "None"
    ? "warning"
    : "success";
};

/** Health of every subsystem at a glance, with the report to copy or save for support. */
export const DiagnosticsPanel = ({ health }: { health: SubsystemHealth }) => {
  const desktop = useSettingsDesktop();
  const backendClient = useSettingsBackend();
  const t = useText();
  const notify = useNotify();
  const { backend, audio } = health;
  const backendStateText = (state: string) =>
    isBackendState(state) ? t(`backendState${state}`) : state;
  const [lighting, setLighting] = useState<KeyboardLightingCapabilities>({
    available: false,
    deviceCount: 0,
  });
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void desktop
        .keyboardLightingCapabilities()
        .then((value) => active && setLighting(value));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  // The latest failed processing jobs are read when the report is made: their errors explain them.
  const report = async () =>
    buildDiagnosticsReport({
      frontendVersion,
      generatedAt: new Date().toISOString(),
      backend,
      audio,
      keyboardLighting: lighting.available,
      jobs: await backendClient.listJobs().catch(() => null),
    });
  const copy = async () => {
    await desktop.copyText(await report());
    notify(t("copied"), "success");
  };
  const exportReport = async () => {
    if (await desktop.saveTextFile("ad-voice-diagnostics.json", await report()))
      notify(t("reportExported"), "success");
  };

  const rows: {
    label: string;
    level: Level;
    value: string;
    primary?: boolean;
  }[] = [
    {
      label: t("pythonBackend"),
      level: backendLevel(backend),
      value: backend ? backendStateText(backend.state) : t("unavailable"),
      primary: true,
    },
    ...(backend
      ? ([
          {
            label: t("database"),
            level: backend.database ? "success" : "error",
            value: t(backend.database ? "healthy" : "unhealthy"),
          },
          {
            label: t("aiRuntime"),
            level: backend.cudaAvailable ? "success" : "warning",
            value: backend.gpuName ?? "CPU",
          },
          {
            label: "FFmpeg",
            level: backend.ffmpegVersion ? "success" : "warning",
            value: backend.ffmpegVersion ?? t("unavailable"),
          },
        ] satisfies typeof rows)
      : []),
    {
      label: t("audioServiceLabel"),
      level: audioLevel(audio),
      value: audio ? (audio.ServiceState ?? "") : t("unavailable"),
      primary: true,
    },
    ...(audio
      ? ([
          {
            label: t("audioXruns"),
            level: "success",
            value: `${audio.XRuns ?? "0"} / ${audio.DeadlineMisses ?? "0"}`,
          },
        ] satisfies typeof rows)
      : []),
    {
      label: t("keyboardLighting"),
      level: lighting.available ? "success" : "warning",
      value: lighting.available
        ? t("keyboardLightingStatus", {
            provider: lighting.provider ?? "OpenRGB",
            count: lighting.deviceCount,
          })
        : t("keyboardLightingUnsupported"),
    },
  ];
  const [primary, secondary] = [true, false].map((primary) => (
    <KeyValueList
      key={String(primary)}
      items={rows
        .filter((row) => Boolean(row.primary) === primary)
        .map((row) => [
          row.label,
          <StatusIndicator
            key={row.label}
            status={row.level}
            label={row.value}
          />,
        ])}
    />
  ));

  return (
    <Card
      border
      className="advancedDiagnosticsCard"
      icon="stethoscope"
      title={t("diagnostics")}
      description={t("diagnosticsHint")}
    >
      <div className="settingsStack">
        {primary}
        <CollapsibleSection title={t("diagnosticsDetails")}>
          {secondary}
        </CollapsibleSection>
        <Stack direction="row" gap={2} wrap>
          <Button size="sm" icon="copy" onClick={() => void copy()}>
            {t("copyDiagnostics")}
          </Button>
          <IconButton
            size="sm"
            icon="download"
            label={t("exportDiagnostics")}
            onClick={() => void exportReport()}
          />
          <IconButton
            size="sm"
            variant="ghost"
            icon="refresh"
            label={t("refresh")}
            onClick={health.refresh}
          />
        </Stack>
      </div>
    </Card>
  );
};
