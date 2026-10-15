import {
  Card,
  IconButton,
  LevelMeter,
  RotaryKnob,
  Stack,
  StatusIndicator,
  Switch,
  Tooltip,
  Typography,
  useFormContext,
} from "@neo-ui-kit/react";
import type { RuntimeAudioConfiguration } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { AcousticCalibration } from "./AcousticCalibration";
import type { SettingsFormValues } from "../../settingsForm";

const meterGain = 4;
/** The stored levels are 0…1; the knobs show them as percent. */
const percent = (value: number) => Math.round(value * 100);

/** Monitoring block: latency estimate with the live input level, level knobs and input monitoring. */
export const AudioTests = ({
  runtime,
  audioAvailable,
  microphoneIssue,
  inputLevel,
  testingInput,
  onToggleInputTest,
}: {
  runtime: RuntimeAudioConfiguration;
  audioAvailable: boolean;
  microphoneIssue: boolean;
  inputLevel: number;
  testingInput: boolean;
  onToggleInputTest(enabled: boolean): void;
  onPlayTestSound(): void;
}) => {
  const t = useText();
  const form = useFormContext<SettingsFormValues>();
  const latencyMs = audioAvailable ? runtime.estimatedLatencyMs : null;
  const parts = audioAvailable ? runtime.latencyParts : undefined;
  const timing = audioAvailable ? runtime.latencyTiming : undefined;
  const sourceLabel = runtime.latencyEstimateSource === "device-timeline"
    ? "latencyTimelineEstimate" : "latencyModelEstimate";
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
    { key: "voiceGain", label: t("microphoneKnob"), reset: 100 },
    { key: "noiseSuppression", label: t("noiseSuppression"), reset: 0 },
  ] as const;

  return (
    <Card
      border
      icon="sliders"
      title={t("audioMonitorTitle")}
      description={t("audioMonitorHint")}
    >
      <div className="audioMonitorGrid">
        <Card
          material="glass"
          padding="sm"
          icon="timer"
          title={t("estimatedLatencyTitle")}
          level={4}
          actions={
              <Tooltip content={latencyCaveat}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  icon="info"
                  label={t("physicalLatencyUnmeasured")}
                />
              </Tooltip>
          }
        >
          <div className="settingsStack">
            <LevelMeter
              active={testingInput}
              value={Math.min(1, inputLevel * meterGain) * 100}
              label={t("liveInputLevel")}
            />
            <div className="audioLatencyRow">
              <Typography variant="h3" as="strong">
                {latencyMs === null
                  ? t(audioAvailable && runtime.latencyEstimateSource === "measuring"
                      ? "latencyMeasuring" : "unavailable")
                  : t("approximateMillisecondsValue", {
                      value: Math.round(latencyMs),
                    })}
              </Typography>
              {latencyMs !== null && (
                <Typography variant="caption" tone="muted">
                  {t(sourceLabel)}
                </Typography>
              )}
              <StatusIndicator
                status={audioAvailable ? "success" : "error"}
                label={t(audioAvailable ? "healthy" : "unavailable")}
              />
            </div>
            <Typography variant="caption" tone="muted">{t("latencyNoCalibrationRequired")}</Typography>
            {audioAvailable && runtime.calibratedLatencyMs != null && (
              <Typography variant="caption" tone="muted">
                {t("latencyActiveCorrection", { value: runtime.calibratedLatencyMs.toFixed(2) })}
              </Typography>
            )}
            <details>
              <summary>{t("latencyTechnicalDetails")}</summary>
              <Typography variant="caption" tone="muted">{t("latencyBoundaryHint")}</Typography>
              {runtime.captureTimestampAdjusted && (
                <Typography variant="caption" tone="muted">{t("latencyTimestampAdjusted")}</Typography>
              )}
              <Typography variant="caption" tone="muted">{t("latencyModelNotAdditive")}</Typography>
            {parts && (
              <Stack as="ul" gap="0.15rem" className="audioLatencyParts">
                {parts.inputMs !== null && (
                  <Typography as="li" variant="caption" tone="muted">
                    {t(
                      parts.inputReportedMs
                        ? "latencyPartInput"
                        : "latencyPartInputAssumed",
                      { value: Math.round(parts.inputMs) },
                    )}
                  </Typography>
                )}
                {parts.outputMs !== null && (
                  <Typography as="li" variant="caption" tone="muted">
                    {t("latencyPartOutput", {
                      value: Math.round(parts.outputMs),
                    })}
                  </Typography>
                )}
                {parts.bridgeMs != null && (
                  <Typography as="li" variant="caption" tone="muted">
                    {t("latencyPartBridge", { value: parts.bridgeMs.toFixed(2) })}
                  </Typography>
                )}
                {parts.dspMs != null && (
                  <Typography as="li" variant="caption" tone="muted">
                    {t("latencyPartDsp", { value: parts.dspMs.toFixed(2) })}
                  </Typography>
                )}
              </Stack>
            )}
            {timing && (
              <Stack gap="0.15rem">
                {([
                  ["latencyRenderCallback", timing.renderCallbackP95Ms],
                  ["latencyCaptureCallback", timing.captureCallbackP95Ms],
                  ["latencyJitWait", timing.jitWaitP95Ms],
                  ["latencyDeadlineOvershoot", timing.deadlineOvershootP95Ms],
                ] as const).map(([label, value]) => value === null ? null : (
                  <Typography key={label} variant="caption" tone="muted">
                    {t(label, { value: value.toFixed(3) })}
                  </Typography>
                ))}
                <Typography variant="caption" tone="muted">{t("latencyTimingNotCpu")}</Typography>
              </Stack>
            )}
            </details>
            <details>
              <summary>{t("latencyOptionalAcoustic")}</summary>
              <AcousticCalibration audioAvailable={audioAvailable} runtime={runtime} />
            </details>
          </div>
        </Card>
        <Card
          material="glass"
          padding="sm"
          icon="levels"
          title={t("audioLevels")}
          level={4}
        >
          <Stack direction="row" gap={4} justify="around" wrap>
            {knobs.map((knob) => (
              <RotaryKnob
                key={knob.key}
                size="sm"
                showLabel
                label={knob.label}
                resetValue={knob.reset}
                value={percent(form.values[knob.key])}
                onValueChange={(value) => form.setValue(knob.key, value / 100)}
              />
            ))}
          </Stack>
        </Card>
        <Card
          material="glass"
          padding="sm"
          icon="headphones"
          title={t("inputMonitoring")}
          level={4}
        >
          <Switch
            size="lg"
            label={t("inputMonitoringHint")}
            aria-label={t("inputMonitoring")}
            checked={testingInput}
            disabled={!audioAvailable || microphoneIssue}
            onValueChange={onToggleInputTest}
          />
        </Card>
      </div>
    </Card>
  );
};
