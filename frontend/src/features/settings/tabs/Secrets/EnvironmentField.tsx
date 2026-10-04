import { useRef } from "react";
import { Button, Icon, IconButton, TextField } from "@ad-voice/ui";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import { effectiveState, fieldUi, isSecret, messageKeyFor, type DisplayEntry, type DisplayState } from "./secretsModel";

const stateIcon: Record<DisplayState, string> = {
  valid: "ok",
  unverified: "check",
  invalid: "warning",
  empty: "minus",
  checking: "processing",
};

/**
 * One ENV value. The state mark at the end says how it stands; only an invalid value spells out
 * its problem under the field. Secrets are write-only: a saved one can be replaced or removed, never
 * read back. File paths are picked with the system dialog.
 */
export const EnvironmentField = ({ entry, onChange, onSave }: {
  entry: DisplayEntry;
  onChange(value: string): void;
  onSave(value: string): void;
}) => {
  const t = useText();
  const fileInput = useRef<HTMLInputElement>(null);
  const meta = fieldUi[entry.key];
  const state = effectiveState(entry);
  const messageKey = messageKeyFor(entry);
  const message = messageKey ? t(messageKey) : entry.message;
  const pick = (file: File | undefined) => {
    const path = file && desktopClient.pathForFile(file);
    if (path) onSave(path);
  };
  const secret = isSecret(entry);
  const savedSecret = secret && entry.configured && !entry.value;

  return (
    <div className="environmentField" data-span={meta?.span ?? 12}>
      <TextField label={meta ? t(meta.label) : entry.key} title={entry.key} value={entry.value} onValueChange={onChange}
        type={secret ? "password" : undefined} autoComplete={secret ? "off" : undefined}
        placeholder={savedSecret ? t("environmentSecretSaved") : undefined}
        error={state === "invalid" ? message : undefined}
        endAdornment={(
          <>
            {savedSecret && (
              <IconButton size="xs" variant="ghost" icon="trash" label={t("environmentRemoveSecret")}
                onClick={() => onSave("")} />
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
