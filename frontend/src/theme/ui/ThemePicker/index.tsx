import { Check } from "lucide-react";
import { Button } from "..";
import type { ThemeName } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { themeIconMotionColors, themeIcons } from "../../../shared/ui/themeIcons";
import { BrandIconMotion } from "../../../shared/ui/BrandIconMotion";
import "./theme-picker.css";

const themeOptions = [
  { value: "dark", label: "themeDark", description: "themeDarkDescription" },
  { value: "light", label: "themeLight", description: "themeLightDescription" },
  { value: "green", label: "themeGreen", description: "themeGreenDescription" },
  { value: "violet", label: "themeViolet", description: "themeVioletDescription" },
] as const satisfies readonly { value: ThemeName; label: MessageKey; description: MessageKey }[];

interface ThemePickerProps {
  value: ThemeName;
  disabled?: boolean;
  onChange(theme: ThemeName): void;
}

/** Custom form control for `GetForm`: one preview card per theme. */
export default ({ value, disabled, onChange }: ThemePickerProps) => {
  const t = useText();
  return (
    <div
      className="themeGrid"
      role="radiogroup"
      aria-label={t("theme")}
    >
      {themeOptions.map((option) => (
        <Button
          key={option.value}
          type="button"
          unstyled
          className="themeOption"
          disabled={disabled}
          aria-pressed={value === option.value}
          aria-label={t(option.label)}
          onClick={() => onChange(option.value)}
        >
          <span className="themeOptionPreview">
            {value === option.value ? (
              <BrandIconMotion
                src={themeIcons[option.value]}
                className="themeOptionAnimatedIcon"
                glow={false}
                colors={themeIconMotionColors[option.value]}
              />
            ) : (
              <img src={themeIcons[option.value]} alt="" width={240} height={166} loading="lazy" />
            )}
          </span>
          <span className="themeOptionCaption">
            <strong>{t(option.label)}</strong>
            <span aria-hidden="true">{t(option.description)}</span>
          </span>
          {value === option.value && <span className="themeOptionSelected" aria-hidden><Check /></span>}
        </Button>
      ))}
    </div>
  );
};
