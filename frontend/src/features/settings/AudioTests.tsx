import { Mic2, Timer } from "lucide-react";
import { useApp } from "../../app/AppContext";
import type { RuntimeAudioConfiguration } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import {
  noiseReduction,
  noiseThreshold,
} from "../../services/noiseSuppression";
import { LiveSignalWaveform } from "../../shared/ui/LiveSignalWaveform";
import { RotaryKnob, Switch } from "../../theme/ui";

const meterGain = 4;
const microphoneGainMax = 1.5;

/** Input test switch with the live waveform, microphone volume knob, latency read-out and output test. */
export const AudioTests = ({
  runtime,
  audioAvailable,
  microphoneIssue,
  inputLevel,
  testingInput,
  onToggleInputTest,
  onPlayTestSound,
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

  return (
    <div className="audioTests">
      <div className="audioTestRow">
        <Mic2 aria-hidden />
        <RotaryKnob
          min={0}
          max={microphoneGainMax}
          step={0.01}
          defaultValue={1}
          displayFactor={100}
          size="md"
          value={preferences.voiceGain}
          onChange={changeMicrophoneVolume}
        />
        <RotaryKnob
          label={t("noiseSuppression")}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0}
          displayFactor={100}
          size="md"
          accent="secondary"
          value={preferences.noiseSuppression}
          onChange={changeNoise}
        />
        <Switch
          variant="plain"
          checked={testingInput}
          disabled={!audioAvailable || microphoneIssue}
          onChange={onToggleInputTest}
        />
        <LiveSignalWaveform
          active={testingInput}
          level={Math.min(1, inputLevel * meterGain)}
          ariaLabel={t("liveInputLevel")}
        />
      </div>
      <p className="muted">{t("inputTestHint")}</p>
      <div className="audioTestRow">
        <Timer aria-hidden />
        <span>{t("estimatedLatency")}</span>
        <strong>
          {t("millisecondsValue", {
            value: runtime.estimatedLatencyMs.toFixed(1),
          })}
        </strong>
        <span className="muted">
          {t(audioAvailable ? "healthy" : "unavailable")}
        </span>
      </div>
    </div>
  );
};
