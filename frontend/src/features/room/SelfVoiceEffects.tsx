import { observer } from "mobx-react-lite";
import { store } from "../../providers/store";
import { RotaryKnob, tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../i18n/messages.ru";
import { voiceEffects } from "../karaoke/console/voiceEffects";

/**
 * The singer's own voice effects in the room panel: the same stored values the karaoke console and
 * the settings show (echo, reverb, delay, auto-tune and noise suppression), applied app-wide.
 */
export const SelfVoiceEffects = observer(() => {
  useLocale();
  const { preferences, updatePreferences } = store;
  return (
    <>
      {voiceEffects.map((effect) => (
        <RotaryKnob
          key={effect.id}
          size="xs"
          showLabel
          label={tr(ru[effect.label])}
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
        label={tr(ru.noiseSuppression)}
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
});
