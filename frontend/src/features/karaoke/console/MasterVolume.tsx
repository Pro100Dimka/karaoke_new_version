import { Volume2, VolumeX } from "lucide-react";
import { useText } from "../../../i18n/useText";
import { masterGainMax } from "../../../shared/preferences/preferences";
import { RotaryKnob } from "../../../theme/ui";

/** Master volume: scales the whole karaoke mix at once, up to a 150 % boost. */
export const MasterVolume = ({ value, onChange }: { value: number; onChange(value: number): void }) => {
  const t = useText();
  const Icon = value === 0 ? VolumeX : Volume2;
  return (
    <div className="masterVolume">
      <Icon aria-hidden />
      <RotaryKnob
        ariaLabel={t("masterVolume")}
        size="xs"
        min={0}
        max={masterGainMax}
        step={0.01}
        defaultValue={1}
        displayFactor={100}
        value={value}
        onChange={onChange}
      />
    </div>
  );
};
