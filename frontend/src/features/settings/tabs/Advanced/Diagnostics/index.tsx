import {
  Button,
  Card,
  CollapsibleSection,
  IconButton,
  KeyValueList,
  Stack,
  StatusIndicator,
} from "@neo-ui-kit/react";
import { useText } from "../../../../../i18n/useText";
import type { SubsystemHealth } from "../hooks/useSubsystemHealth";

import { useDiagnosticsActions } from "./hooks/useDiagnosticsActions";

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

const backendLevel = (backend: SubsystemHealth["backend"]): Level => {
  if (!backend || backend.state === "Failed") return "error";
  return backend.state === "Ready" ? "success" : "warning";
};
const audioLevel = (audio: SubsystemHealth["audio"]): Level => {
  if (!audio || audio.ServiceState === "Failed") return "error";
  if (audio.ServiceState !== "Running" && audio.ServiceState !== "Ready")
    return "warning";
  return audio.LastFailureCode && audio.LastFailureCode !== "None"
    ? "warning"
    : "success";
};

/** Health of every subsystem at a glance, with the report to copy or save for support. */
export const DiagnosticsPanel = ({ health }: { health: SubsystemHealth }) => {
  const t = useText();
  const { backend, audio } = health;
  const { lighting, deliverReport } = useDiagnosticsActions(health);
  const backendStateText = (state: string) =>
    isBackendState(state) ? t(`backendState${state}`) : state;

  const rows: {
    label: string;
    level: Level;
    value: string;
    primary?: boolean;
  }[] = [
    {
      label: t("pythonBackend"),
      level: health.loading && !backend ? "warning" : backendLevel(backend),
      value: backend
        ? backendStateText(backend.state)
        : t(health.loading ? "loadingSettings" : "unavailable"),
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
      level: health.loading && !audio ? "warning" : audioLevel(audio),
      value: audio
        ? (audio.ServiceState ?? "")
        : t(health.loading ? "loadingSettings" : "unavailable"),
      primary: true,
    },
    ...(audio
      ? ([
          {
            label: t("audioXruns"),
            level:
              Number(audio.XRuns ?? "0") === 0 &&
              Number(audio.DeadlineMisses ?? "0") === 0
                ? "success"
                : "warning",
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
      style={{
        background: "unset!important",
        height: "100%",
        boxShadow: "unset!important",
      }}
      description={t("diagnosticsHint")}
    >
      <div className="settingsStack">
        {primary}
        <CollapsibleSection title={t("diagnosticsDetails")}>
          {secondary}
        </CollapsibleSection>
        <Stack direction="row" gap={2} wrap>
          <Button
            size="sm"
            icon="copy"
            onClick={() => void deliverReport("clipboard")}
          >
            {t("copyDiagnostics")}
          </Button>
          <IconButton
            size="sm"
            icon="download"
            label={t("exportDiagnostics")}
            onClick={() => void deliverReport("file")}
          />
          <IconButton
            size="sm"
            variant="ghost"
            icon="refresh"
            label={t("refresh")}
            disabled={health.loading}
            onClick={health.refresh}
          />
        </Stack>
      </div>
    </Card>
  );
};
