import { FolderOpen } from "lucide-react";
import { forwardRef } from "react";
import { useText } from "../../../i18n/useText";
import IconButton from "../IconButton";
import TextField, { type TextFieldProps } from "../TextField";
import cx from "../_internal/cx";
import "./folder-field.css";

export interface FolderFieldProps extends TextFieldProps {
  /** Opens the native folder picker; without it the field is a plain text input. */
  onBrowse?: () => void;
  browseLabel?: string;
}

const FolderField = forwardRef<HTMLElement, FolderFieldProps>(
  ({ value = "", placeholder, disabled = false, onBrowse, readOnly = Boolean(onBrowse), browseLabel, className, inputClassName, ...props }, ref) => {
    const t = useText();
    const label = browseLabel ?? t("browse");
    const browse = () => {
      if (!disabled) onBrowse?.();
    };

    return (
      <TextField
        {...props}
        ref={ref}
        value={value}
        placeholder={placeholder ?? t("folderPlaceholder")}
        readOnly={readOnly}
        disabled={disabled}
        title={String(value || label)}
        className={cx("ui-folder-field", className)}
        inputClassName={cx("ui-folder-field-input", inputClassName)}
        onClick={onBrowse ? browse : undefined}
        end={
          onBrowse ? (
            <IconButton icon={FolderOpen} variant="ghost" size="sm" disabled={disabled} aria-label={label} title={label} onClick={browse} />
          ) : undefined
        }
      />
    );
  }
);

FolderField.displayName = "FolderField";
export default FolderField;
