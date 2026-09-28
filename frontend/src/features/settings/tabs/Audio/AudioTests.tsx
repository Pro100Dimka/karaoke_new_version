import {
  AudioLines,
  ChartNoAxesColumnIncreasing,
  CircleCheck,
  CircleX,
  Headphones,
  Info,
  Mic,
  SlidersVertical,
  Timer,
} from "lucide-react";
import { useApp } from "../../../../app/AppContext";
import type { RuntimeAudioConfiguration } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { audioClient } from "../../../../services/audioClient";
import {
  noiseReduction,
  noiseThreshold,
} from "../../../../services/noiseSuppression";
import { LiveSignalWaveform } from "../../../../shared/ui/LiveSignalWaveform";
import { RotaryKnob, Switch, Tooltip } from "../../../../theme/ui";
import { AudioSection } from "./AudioSection";

const meterGain = 4;
const microphoneGainMax = 1;

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
  const { preferences, updatePreferences } = useApp();
  const changeMicrophoneVolume = (value: number) => {
    updatePreferences({ voiceGain: value });
    void audioClient.setMixer("mic", value).catch(() => undefined);
  };
  const changeNoise = (value: number) => {
    updatePreferences({ noiseSuppression: value });
    void Promise.all([
      audioClient.setDspParameter("noise.threshold", noiseThreshold(value)),
      audioClient.setDspParameter("noise.reduction", noiseReduction(value)),
      audioClient.setDspEnabled(value > 0),
    ]).catch(() => undefined);
  };
  const latencyMs = audioAvailable ? runtime.estimatedLatencyMs : null;
  // The estimate covers only what the audio system reports; the tooltip keeps that caveat at hand.
  const latencyCaveat = (
    <span className="audioLatencyCaveat">
      <strong>{t("physicalLatencyUnmeasured")}</strong>
      <span>{t("estimatedLatency")}</span>
      <span>{t("physicalLatencyHint")}</span>
    </span>
  );

  return (
    <AudioSection
      icon={SlidersVertical}
      title={t("audioMonitorTitle")}
      hint={t("audioMonitorHint")}
    >
      <div className="audioMonitorGrid">
        <article className="audioMonitorCard audioLatencyCard">
          <header className="audioMonitorCardHeader">
            <Timer aria-hidden />
            <h4>{t("estimatedLatencyTitle")}</h4>
            <Tooltip title={latencyCaveat}>
              <button
                type="button"
                className="audioInfoButton"
                aria-label={t("physicalLatencyUnmeasured")}
              >
                <Info aria-hidden />
              </button>
            </Tooltip>
          </header>
          <LiveSignalWaveform
            active={testingInput}
            level={Math.min(1, inputLevel * meterGain)}
            ariaLabel={t("liveInputLevel")}
          />
          <div className="audioLatencyRow">
            <strong className="audioLatencyValue">
              {latencyMs === null
                ? t("unavailable")
                : t("approximateMillisecondsValue", {
                    value: Math.round(latencyMs),
                  })}
            </strong>
            <span
              className="audioStatusBadge"
              data-state={audioAvailable ? "ok" : "error"}
            >
              {audioAvailable ? (
                <CircleCheck aria-hidden />
              ) : (
                <CircleX aria-hidden />
              )}
              {t(audioAvailable ? "healthy" : "unavailable")}
            </span>
          </div>
        </article>
        <article className="audioMonitorCard">
          <header className="audioMonitorCardHeader">
            <ChartNoAxesColumnIncreasing aria-hidden />
            <h4>{t("audioLevels")}</h4>
          </header>
          <div className="audioKnobs">
            <RotaryKnob
              label={
                <span className="audioKnobLabel">
                  {t("microphoneKnob")}
                  <Mic aria-hidden />
                </span>
              }
              ariaLabel={t("microphoneVolume")}
              min={0}
              max={microphoneGainMax}
              step={0.01}
              defaultValue={1}
              displayFactor={100}
              size="xs"
              value={preferences.voiceGain}
              onChange={changeMicrophoneVolume}
            />
            <RotaryKnob
              label={
                <span className="audioKnobLabel">
                  {t("noiseSuppression")}
                  <AudioLines aria-hidden />
                </span>
              }
              ariaLabel={t("noiseSuppression")}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              displayFactor={100}
              size="xs"
              accent="secondary"
              value={preferences.noiseSuppression}
              onChange={changeNoise}
            />
          </div>
        </article>
        <article className="audioMonitorCard">
          <header className="audioMonitorCardHeader">
            <Headphones aria-hidden />
            <h4>{t("inputMonitoring")}</h4>
          </header>
          <div className="audioMonitorSwitch">
            <Switch
              variant="plain"
              size="lg"
              checked={testingInput}
              disabled={!audioAvailable || microphoneIssue}
              onChange={onToggleInputTest}
              aria-label={t("inputMonitoring")}
            />
            <span className="muted">{t("inputMonitoringHint")}</span>
          </div>
        </article>
      </div>
    </AudioSection>
  );
};
