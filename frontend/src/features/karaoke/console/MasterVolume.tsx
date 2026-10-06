import { Icon, RotaryKnob } from "@ad-voice/ui";
import { useText } from "../../../i18n/useText";

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
        diameter={52}
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
