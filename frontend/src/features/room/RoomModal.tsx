import { useState } from "react";
import { Button, Dialog, Icon, MessageBar, NeonWaves, Tabs, TextField, Typography, useForm } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { enterRoom } from "./enterRoom";
import "./room-entry.css";

type RoomMode = "join" | "create";

/** Joining a room by its code, or creating one under the name the others will see. */
export const RoomModal = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const { setRoom, preferences, updatePreferences } = useApp();
  const t = useText();
  const [mode, setMode] = useState<RoomMode>("join");
  const [failure, setFailure] = useState<string>();
  const joining = mode === "join";

  const form = useForm({
    initialValues: { name: preferences.displayName, code: "" },
    reinitialize: false,
    validate: values => ({
      ...(values.name.trim() ? {} : { name: t("fieldRequired") }),
      ...(joining && !values.code.trim() ? { code: t("fieldRequired") } : {}),
    }),
    onSubmit: async values => {
      setFailure(undefined);
      try {
        const name = values.name.trim();
        const room = await enterRoom(name, joining ? values.code.trim() : undefined);
        updatePreferences({ displayName: name });
        setRoom(room);
        onClose();
      } catch (error) {
        setFailure(t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"));
      }
    },
  });
  const field = (name: "name" | "code") => ({
    name,
    value: form.values[name],
    error: form.touched[name] ? form.errors[name] : undefined,
    onValueChange: (value: string) => form.setValue(name, value),
    onBlur: () => form.setTouched(name),
  });

  const selectMode = (next: RoomMode) => {
    setMode(next);
    setFailure(undefined);
    form.reset(form.values);
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }} className="roomEntryDialog" width="wide"
      icon="users" title={t("roomTitle")} description={t("roomIntro")} closeLabel={t("closeDialog")}
      cancelLabel={false} confirmLabel={false} art={<NeonWaves className="roomEntryWaves" strands={24} />}>
      <form className="roomEntryForm" noValidate onSubmit={event => {
        event.preventDefault();
        // A submit attempt shows what is still missing, like leaving each field would.
        form.setTouched("name");
        form.setTouched("code");
        void form.submit();
      }}>
        <Typography variant="eyebrow" tone="accent" className="roomEntryEyebrow">{t("onlineRoom")}</Typography>
        <Tabs<RoomMode> label={t("onlineRoom")} value={mode} onValueChange={selectMode} items={[
          { value: "join", label: t("joinByCode"), icon: "login" },
          { value: "create", label: t("createRoom"), icon: "users" },
        ]} />
        <TextField {...field("name")} label={t("displayName")} required clearable autoComplete="name"
          startAdornment={<Icon name="person" />} />
        {joining && (
          <TextField {...field("code")} label={t("roomCode")} required autoComplete="off" placeholder={t("roomCodePlaceholder")}
            startAdornment={<Icon name="key" />} />
        )}
        {failure && <MessageBar tone="error">{failure}</MessageBar>}
        <div className="roomEntryActions">
          <Button disabled={form.submitting} onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" icon={joining ? "login" : "users"} loading={form.submitting}>
            {t(joining ? "joinRoom" : "createRoom")}
          </Button>
        </div>
        {joining && (
          <Button variant="ghost" icon="users" endIcon="chevron" className="roomEntryShortcut" onClick={() => selectMode("create")}>
            <strong>{t("noRoomCode")}</strong> {t("createAndInvite")}
          </Button>
        )}
      </form>
    </Dialog>
  );
};
