import { Button } from "..";
import type { ThemeName } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { themeIconMotionColors, themeIcons } from "../../../shared/ui/themeIcons";
import { BrandIconMotion } from "../../../shared/ui/BrandIconMotion";
import FloatingLabel from "../_internal/FloatingLabel";
import "./theme-picker.css";

const themeOptions = [
  { value: "dark", label: "themeDark" },
  { value: "light", label: "themeLight" },
  { value: "green", label: "themeGreen" },
  { value: "violet", label: "themeViolet" },
] as const satisfies readonly { value: ThemeName; label: MessageKey }[];

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
      role="group"
      aria-label={t("theme")}
      style={{ position: "relative" }}
    >
      <FloatingLabel
        id={"theme"}
        label={t("theme").toUpperCase()}
        style={{
          top: "0",
          left: "50%",
          transform: "translate(-50%, -100%)",
        }}
      />
      {themeOptions.map((option) => (
        <Button
          key={option.value}
          type="button"
          unstyled
          className="themeOption"
          disabled={disabled}
          aria-pressed={value === option.value}
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
          <span className="themeOptionLabel">{t(option.label)}</span>
        </Button>
      ))}
    </div>
  );
};
