import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { RotaryKnob } from "../../theme/ui";
import { voiceEffects } from "../karaoke/console/voiceEffects";

/**
 * The singer's own voice effects in the room panel: the same stored values the karaoke console and
 * the settings show (echo, reverb, delay, auto-tune and noise suppression), applied app-wide.
 */
export const SelfVoiceEffects = () => {
  const t = useText();
  const { preferences, updatePreferences } = useApp();
  return (
    <>
      {voiceEffects.map((effect) => (
        <RotaryKnob
          key={effect.id}
          label={t(effect.label)}
          min={effect.min}
          max={effect.max}
          step={effect.step}
          size="xs"
          displayFactor={100}
          valueSuffix="%"
          defaultValue={effect.initial}
          value={preferences.karaokeEffects[effect.id]}
          onChange={(value) =>
            updatePreferences({ karaokeEffects: { ...preferences.karaokeEffects, [effect.id]: value } })}
        />
      ))}
      <RotaryKnob
        label={t("noiseSuppression")}
        min={0}
        max={1}
        step={0.01}
        size="xs"
        displayFactor={100}
        valueSuffix="%"
        defaultValue={0}
        value={preferences.noiseSuppression}
        onChange={(value) => updatePreferences({ noiseSuppression: value })}
      />
    </>
  );
};
