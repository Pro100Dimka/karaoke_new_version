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
} from "@ad-voice/ui";
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
                  ? t("unavailable")
                  : t("approximateMillisecondsValue", {
                      value: Math.round(latencyMs),
                    })}
              </Typography>
              <StatusIndicator
                status={audioAvailable ? "success" : "error"}
                label={t(audioAvailable ? "healthy" : "unavailable")}
              />
            </div>
            <AcousticCalibration
              audioAvailable={audioAvailable}
              runtime={runtime}
            />
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
