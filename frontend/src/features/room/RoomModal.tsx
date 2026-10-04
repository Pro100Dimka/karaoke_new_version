import { useState } from "react";
import { Avatar, Beacon, Button, Card, Dialog, Icon, MessageBar, NeonWaves, Stack, TextField, Typography } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { enterRoom } from "./enterRoom";
import "./room-entry.css";

type Busy = "create" | "join" | null;

/**
 * Singing together in one step: your name on top, then two choices side by side. Creating opens a
 * room at once; a pasted code (or Enter) joins it at once.
 */
export const RoomModal = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const { setRoom, preferences, updatePreferences } = useApp();
  const t = useText();
  const [name, setName] = useState(preferences.displayName);
  const [code, setCode] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState<Busy>(null);

  const enter = async (roomCode?: string) => {
    const trimmed = name.trim();
    setFailure(undefined);
    setNameError(trimmed ? undefined : t("fieldRequired"));
    if (roomCode !== undefined) setCodeError(roomCode.trim() ? undefined : t("fieldRequired"));
    if (!trimmed || (roomCode !== undefined && !roomCode.trim())) return;
    setBusy(roomCode === undefined ? "create" : "join");
    try {
      const room = await enterRoom(trimmed, roomCode?.trim());
      updatePreferences({ displayName: trimmed });
      setRoom(room);
      onClose();
    } catch (error) {
      setFailure(t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }} className="roomEntryDialog" width="wide"
      icon="users" title={t("roomTitle")} description={t("roomIntro")} closeLabel={t("closeDialog")}
      cancelLabel={false} confirmLabel={false} art={<NeonWaves className="roomEntryWaves" shape="ridge" comets={3} strands={24} />}>
      <div className="roomEntry">
        <Stack direction="row" gap={4} align="center">
          <Avatar size="lg" name={name.trim() || "?"} />
          <TextField className="roomEntryName" name="name" label={t("displayName")} required clearable autoComplete="name"
            value={name} error={nameError} onValueChange={value => { setName(value); setNameError(undefined); }} />
        </Stack>

        <div className="roomEntryChoices">
          <div className="roomEntryChoice">
            <Card border padding="md" className="roomEntryCard" data-choice="create">
              <Beacon active={busy === null}><Icon name="users" surface="tile" size={28} /></Beacon>
              <Typography as="h3" variant="title">{t("createRoom")}</Typography>
              <Typography variant="body-sm" tone="muted">{t("createAndInvite")}</Typography>
              <Button variant="primary" icon="plus" loading={busy === "create"} disabled={busy === "join"} onClick={() => void enter()}>
                {t("createRoom")}
              </Button>
            </Card>
          </div>

          <div className="roomEntryChoice">
            <Card border padding="md" className="roomEntryCard" data-choice="join">
              <Icon name="key" surface="tile" size={28} />
              <Typography as="h3" variant="title">{t("joinByCode")}</Typography>
              <form className="roomEntryJoin" noValidate onSubmit={event => { event.preventDefault(); void enter(code); }}>
                <TextField className="roomEntryCode" name="code" label={t("roomCode")} required autoComplete="off" placeholder={t("roomCodePlaceholder")}
                  value={code} error={codeError} description={t("roomCodePasteHint")}
                  onValueChange={value => { setCode(value); setCodeError(undefined); }}
                  // A pasted code is a complete one: join right away.
                  onPaste={event => {
                    const pasted = event.clipboardData.getData("text").trim();
                    if (!pasted) return;
                    event.preventDefault();
                    setCode(pasted);
                    void enter(pasted);
                  }} />
                <Button type="submit" variant="primary" icon="login" loading={busy === "join"} disabled={busy === "create"}>
                  {t("joinRoom")}
                </Button>
              </form>
            </Card>
          </div>
        </div>

        {failure && <MessageBar tone="error">{failure}</MessageBar>}
      </div>
    </Dialog>
  );
};
