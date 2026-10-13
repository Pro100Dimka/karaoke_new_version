import { Icon, RotaryKnob } from "@neo-ui-kit/react";
import { useText } from "../../../i18n/useText";
import { fixedKnobWidth } from "../../../shared/ui/knobWidth";

const diameter = 70;

/** Master volume: scales the whole karaoke mix at once. */
export const MasterVolume = ({
  value,
  onChange,
}: {
  value: number;
  onChange(value: number): void;
}) => {
  const t = useText();
  return (
    <div className="masterVolume">
      <Icon
        name="volume"
        className={value === 0 ? "masterVolumeMuted" : undefined}
      />
      <RotaryKnob
        diameter={diameter}
        style={fixedKnobWidth(diameter)}
        label={t("masterVolume")}
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
};
