import {
  Card,
  Divider,
  Header,
  IconButton,
  LevelMeter,
  Popover,
  RotaryKnob,
  Stack,
  StatusIndicator,
  Tooltip,
  Typography,
} from "@neo-ui-kit/react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import type { RuntimeAudioConfiguration } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { AcousticCalibration } from "./AcousticCalibration";
import { useApp } from "../../../../../app/AppContext";
import { useInputMonitoring } from "../hooks/useInputMonitoring";

const meterGain = 4;
/** The stored levels are 0…1; the knobs show them as percent. */
const percent = (value: number) => Math.round(value * 100);

type AudioMonitoringProps = {
  runtime: RuntimeAudioConfiguration;
  audioAvailable: boolean;
  microphoneIssue: boolean;
  latencyControls: ReactNode;
  deviceControls: ReactNode;
  technicalControls?: ReactNode;
};

/** Monitoring block: latency estimate with the live input level, level knobs and input monitoring. */
export const AudioMonitoring = (props: AudioMonitoringProps) => {
  const { runtime, audioAvailable } = props;
  const t = useText();
  const { preferences, updatePreferences } = useApp("preferences");
  const { inputLevel, testingInput, canToggle, setTestingInput } =
    useInputMonitoring(audioAvailable && !props.microphoneIssue);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnosticsAnchor = useRef<HTMLButtonElement>(null);
  const latencyMs = audioAvailable ? runtime.estimatedLatencyMs : null;
  const parts = audioAvailable ? runtime.latencyParts : undefined;
  const timing = audioAvailable ? runtime.latencyTiming : undefined;
  const notes = [
    "latencyNoCalibrationRequired",
    "latencyBoundaryHint",
    ...(runtime.captureTimestampAdjusted
      ? (["latencyTimestampAdjusted"] as const)
      : []),
    "latencyModelNotAdditive",
  ] as const;
  const partRows = parts
    ? ([
        [
          parts.inputReportedMs
            ? "latencyPartInput"
            : "latencyPartInputAssumed",
          parts.inputMs === null ? null : Math.round(parts.inputMs),
        ],
        [
          "latencyPartOutput",
          parts.outputMs === null ? null : Math.round(parts.outputMs),
        ],
        ["latencyPartBridge", parts.bridgeMs?.toFixed(2) ?? null],
        ["latencyPartDsp", parts.dspMs?.toFixed(2) ?? null],
      ] as const)
    : [];
  // The estimate covers only what the audio system reports; the tooltip keeps that caveat at hand.
  const latencyCaveat = (
    <Stack as="span" gap="0.35rem">
      <strong>{t("physicalLatencyUnmeasured")}</strong>
      <span>{t("estimatedLatency")}</span>
      <span>{t("physicalLatencyHint")}</span>
    </Stack>
  );
  // The stored values are applied by the app-wide voice chain, the same ones karaoke and rooms show.
  const knobs = [
    { key: "voiceGain", label: t("microphoneKnob"), reset: 100, max: 400 },
    {
      key: "noiseSuppression",
      label: t("noiseSuppression"),
      reset: 0,
      max: 100,
    },
  ] as const;

  return (
    <Card
      className="audioConsole"
      border
      padding="none"
      icon="wave"
      title={t("audioDevicesTitle")}
      description={t("audioDevicesHint")}
    >
      <div className="audioSettingsGrid">
        <section
          className="audioLatencyPanel"
          aria-label={t("estimatedLatencyTitle")}
        >
          <Header
            compact
            icon="timer"
            title={t("estimatedLatencyTitle")}
            level={4}
            actions={
              <Tooltip content={latencyCaveat}>
                <IconButton
                  ref={diagnosticsAnchor}
                  size="sm"
                  variant="ghost"
                  icon="info"
                  label={t("physicalLatencyUnmeasured")}
                  aria-pressed={diagnosticsOpen}
                  onClick={() => setDiagnosticsOpen((open) => !open)}
                />
              </Tooltip>
            }
          />
          <Stack className="audioLatencyContent" gap={2}>
            <LevelMeter
              active={testingInput}
              value={Math.min(1, inputLevel * meterGain) * 100}
              label={t("liveInputLevel")}
            />
            <Stack direction="row" gap={3} align="center">
              <Typography
                className="audioLatencyValue"
                variant="h3"
                as="strong"
              >
                {latencyMs === null
                  ? t(
                      audioAvailable &&
                        runtime.latencyEstimateSource === "measuring"
                        ? "latencyMeasuring"
                        : "unavailable",
                    )
                  : t("approximateMillisecondsValue", {
                      value: Math.round(latencyMs),
                    })}
              </Typography>
              <StatusIndicator
                status={audioAvailable ? "success" : "error"}
                label={t(audioAvailable ? "healthy" : "unavailable")}
              />
            </Stack>
            {props.latencyControls}
          </Stack>
          <Popover
            open={diagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
            anchorRef={diagnosticsAnchor}
            label={t("latencyTechnicalDetails")}
            align="start"
          >
            <Stack className="audioDiagnosticsPanel" gap={3}>
              <Header
                compact
                icon="info"
                level={4}
                title={t("latencyTechnicalDetails")}
              />
              {notes.map((note) => (
                <Typography key={note} variant="caption" tone="muted">
                  {t(note)}
                </Typography>
              ))}
              {parts && (
                <Stack as="ul" gap="0.15rem" className="audioLatencyParts">
                  {partRows.map(([label, value]) =>
                    value === null ? null : (
                      <Typography
                        key={label}
                        as="li"
                        variant="caption"
                        tone="muted"
                      >
                        {t(label, { value })}
                      </Typography>
                    ),
                  )}
                </Stack>
              )}
              {timing && (
                <Stack gap="0.15rem">
                  {(
                    [
                      ["latencyRenderCallback", timing.renderCallbackP95Ms],
                      ["latencyCaptureCallback", timing.captureCallbackP95Ms],
                      ["latencyJitWait", timing.jitWaitP95Ms],
                      [
                        "latencyDeadlineOvershoot",
                        timing.deadlineOvershootP95Ms,
                      ],
                    ] as const
                  ).map(([label, value]) =>
                    value === null ? null : (
                      <Typography key={label} variant="caption" tone="muted">
                        {t(label, { value: value.toFixed(3) })}
                      </Typography>
                    ),
                  )}
                  <Typography variant="caption" tone="muted">
                    {t("latencyTimingNotCpu")}
                  </Typography>
                </Stack>
              )}
              {audioAvailable && runtime.calibratedLatencyMs != null && (
                <Typography variant="caption" tone="muted">
                  {t("latencyActiveCorrection", {
                    value: runtime.calibratedLatencyMs.toFixed(2),
                  })}
                </Typography>
              )}
              {props.technicalControls}
              <Header
                compact
                icon="wave"
                level={4}
                title={t("latencyOptionalAcoustic")}
              />
              <AcousticCalibration
                audioAvailable={audioAvailable}
                runtime={runtime}
              />
            </Stack>
          </Popover>
        </section>
        <Divider vertical className="audioColumnDivider" />
        <section className="audioLevelsPanel" aria-label={t("audioLevels")}>
          <Header compact icon="levels" title={t("audioLevels")} level={4} />
          <Stack
            className="audioLevelControls"
            direction="row"
            gap={2}
            justify="around"
            align="center"
          >
            {knobs.map((knob, index) => (
              <Fragment key={knob.key}>
                <RotaryKnob
                  size="sm"
                  showLabel
                  label={knob.label}
                  max={knob.max}
                  resetValue={knob.reset}
                  value={percent(preferences[knob.key])}
                  onValueChange={(value) =>
                    updatePreferences({ [knob.key]: value / 100 })
                  }
                />
                {index === 0 && (
                  <Stack gap="0.25rem" align="center">
                    <IconButton
                      round
                      size="lg"
                      icon="mic"
                      label={t("inputMonitoring")}
                      aria-pressed={testingInput}
                      variant={testingInput ? "primary" : "secondary"}
                      disabled={!canToggle}
                      onClick={() => setTestingInput(!testingInput)}
                    />
                    <Typography variant="caption" tone="muted">
                      {t("monitoring")}
                    </Typography>
                    {testingInput && (
                      <Typography variant="caption" tone="success">
                        {t("enabled")}
                      </Typography>
                    )}
                  </Stack>
                )}
              </Fragment>
            ))}
          </Stack>
        </section>
        <Divider vertical className="audioColumnDivider" />
        <section
          className="audioDevicesPanel"
          aria-label={t("audioDevicesAndMonitoring")}
        >
          <Header
            compact
            icon="headphones"
            title={t("audioDevicesAndMonitoring")}
            level={4}
          />
          {props.deviceControls}
        </section>
      </div>
    </Card>
  );
};
