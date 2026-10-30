import { memo } from "react";
import { Icon, RotaryKnob, tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../../i18n/messages.ru";
import { fixedKnobWidth } from "../../../shared/ui/knobWidth";

const diameter = 52;

/** Master volume: scales the whole karaoke mix at once. */
export const MasterVolume = memo(({
  value,
  onChange,
}: {
  value: number;
  onChange(value: number): void;
}) => {
  useLocale();
  return (
    <div className="masterVolume">
      <Icon
        name="volume"
        className={value === 0 ? "masterVolumeMuted" : undefined}
      />
      <RotaryKnob
        diameter={diameter}
        style={fixedKnobWidth(diameter)}
        label={tr(ru.masterVolume)}
        min={0}
        max={1}
        step={0.01}
        displayScale={100}
        resetValue={1}
        value={value}
        onValueChange={onChange}
      />
    </div>
  );
});
