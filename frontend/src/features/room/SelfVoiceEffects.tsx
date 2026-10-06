import { RotaryKnob } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { voiceEffects } from "../karaoke/console/voiceEffects";

/**
 * The singer's own voice effects in the room panel: the same stored values the karaoke console and
 * the settings show (echo, reverb, delay, auto-tune and noise suppression), applied app-wide.
 */
export const SelfVoiceEffects = () => {
  const t = useText();
  const { preferences, updatePreferences } = useApp("preferences");
  return (
    <>
      {voiceEffects.map((effect) => (
        <RotaryKnob
          key={effect.id}
          size="xs"
          showLabel
          label={t(effect.label)}
          min={effect.min}
          max={effect.max}
          step={effect.step}
          displayScale={100}
          resetValue={effect.initial}
          value={preferences.karaokeEffects[effect.id]}
          onValueChange={(value) =>
            updatePreferences({
              karaokeEffects: {
                ...preferences.karaokeEffects,
                [effect.id]: value,
              },
            })
          }
        />
      ))}
      <RotaryKnob
        size="xs"
        showLabel
        label={t("noiseSuppression")}
        min={0}
        max={1}
        step={0.01}
        displayScale={100}
        resetValue={0}
        value={preferences.noiseSuppression}
        onValueChange={(value) =>
          updatePreferences({ noiseSuppression: value })
        }
      />
    </>
  );
};
