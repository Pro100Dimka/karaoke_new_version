import { useRef } from "react";
import { Button, Icon, IconButton, TextField } from "@ad-voice/ui";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import { effectiveState, fieldUi, messageKeyFor, type DisplayEntry, type DisplayState } from "./secretsModel";

const stateIcon: Record<DisplayState, string> = {
  valid: "ok",
  unverified: "check",
  invalid: "warning",
  empty: "minus",
  checking: "processing",
};

/**
 * One ENV value. The state mark at the end says how it stands; only an invalid value spells out
 * its problem under the field. Secrets can be copied, file paths picked with the system dialog.
 */
export const EnvironmentField = ({ entry, onChange, onPick }: {
  entry: DisplayEntry;
  onChange(value: string): void;
  onPick(path: string): void;
}) => {
  const t = useText();
  const fileInput = useRef<HTMLInputElement>(null);
  const meta = fieldUi[entry.key];
  const state = effectiveState(entry);
  const messageKey = messageKeyFor(entry);
  const message = messageKey ? t(messageKey) : entry.message;
  const pick = (file: File | undefined) => {
    const path = file && desktopClient.pathForFile(file);
    if (path) onPick(path);
  };

  return (
    <div className="environmentField" data-span={meta?.span ?? 12}>
      <TextField label={meta ? t(meta.label) : entry.key} title={entry.key} value={entry.value} onValueChange={onChange}
        error={state === "invalid" ? message : undefined}
        endAdornment={(
          <>
            {entry.kind === "secret" && entry.value.trim() && (
              <IconButton size="xs" variant="ghost" icon="copy" label={t("environmentCopyValue")}
                onClick={() => void desktopClient.copyText(entry.value)} />
            )}
            {entry.kind === "file" && (
              <Button size="xs" variant="ghost" icon="folder" onClick={() => fileInput.current?.click()}>{t("selectFile")}</Button>
            )}
            <span className="environmentStatus" data-state={state} role="img" aria-label={message} title={message}>
              <Icon name={stateIcon[state]} />
            </span>
          </>
        )} />
      {entry.kind === "file" && (
        <input ref={fileInput} type="file" hidden tabIndex={-1} aria-hidden="true"
          onChange={event => pick(event.currentTarget.files?.[0])} />
      )}
    </div>
  );
};
