import { Mic2, Timer, Volume2 } from "lucide-react";
import { useApp } from "../../app/AppContext";
import type { RuntimeAudioConfiguration } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { LiveSignalWaveform } from "../../shared/ui/LiveSignalWaveform";
import { Button, RotaryKnob, Switch } from "../../theme/ui";

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
        <Volume2 aria-hidden />
        <span>{t("outputTest")}</span>
        <Button
          type="button"
          size="sm"
          variant="outlined"
          tone="neutral"
          disabled={!audioAvailable}
          onClick={onPlayTestSound}
        >
          {t("playTestSound")}
        </Button>
      </div>
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
