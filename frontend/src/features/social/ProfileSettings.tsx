import { Copy, Eye, ImagePlus, Trash2, Truck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { socialClient } from "../../services/socialClient";
import { Button, IconButton, Stack, TextField, Typography } from "../../theme/ui";
import { avatarFromFile } from "./avatarImage";
import { PersonAvatar } from "./PersonAvatar";
import { useSocial } from "./SocialContext";
import { useSocialAction } from "./useSocialAction";
import "./social.css";

/** The profile photo others see, and the code that moves the account to another computer. */
export const ProfileSettings = () => {
  const t = useText();
  const ask = useAsk();
  const notify = useNotify();
  const inbox = useSocial();
  const { preferences } = useApp();
  const { busy, run } = useSocialAction();
  const picker = useRef<HTMLInputElement>(null);
  const [showCode, setShowCode] = useState(false);
  const [transferCode, setTransferCode] = useState("");
  if (inbox.type !== "inbox") return <Typography variant="body2" tone="muted">{t("socialOffline")}</Typography>;
  const { me } = inbox;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    let photo: { mime: string; data: string };
    try {
      photo = await avatarFromFile(file);
    } catch {
      notify(t("photoUnreadable"), "error");
      return;
    }
    await run(() => socialClient.setAvatar(photo.mime, photo.data), t("photoSaved"));
  };
  const transfer = async (event: FormEvent) => {
    event.preventDefault();
    const choice = await ask({
      title: t("transferAccount"),
      body: t("transferConfirm"),
      tone: "warning",
      actions: [{ id: "cancel", label: t("cancel") }, { id: "move", label: t("transferAccount"), appearance: "primary" }],
    });
    if (choice === "move" && await run(() => socialClient.transfer(transferCode), t("transferDone"))) setTransferCode("");
  };

  return (
    <Stack gap="var(--space-4)" className="profileSettings">
      <Typography variant="h4">{t("profile")}</Typography>
      <Stack direction="row" align="center" gap="var(--space-4)">
        <PersonAvatar size="lg" accountId={me.accountId} avatarVersion={me.avatarVersion} name={preferences.displayName || me.displayName} />
        <Stack gap="var(--space-2)">
          <Typography variant="body2" tone="muted">{t("profilePhotoHint")}</Typography>
          <Stack direction="row" gap="var(--space-2)">
            <Button size="sm" disabled={busy} startIcon={<ImagePlus size={16} />} onClick={() => picker.current?.click()}>{t("choosePhoto")}</Button>
            {me.avatarVersion > 0 && (
              <Button size="sm" variant="outlined" disabled={busy} startIcon={<Trash2 size={16} />} onClick={() => void run(() => socialClient.clearAvatar())}>{t("removePhoto")}</Button>
            )}
          </Stack>
        </Stack>
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
      </Stack>
      <Stack gap="var(--space-2)">
        <Typography variant="body1">{t("transferCode")}</Typography>
        <Typography variant="body2" tone="muted">{t("transferCodeHint")}</Typography>
        <Stack direction="row" align="center" gap="var(--space-2)">
          {showCode
            ? <code className="friendCode">{me.transferCode}</code>
            : <Button size="sm" variant="outlined" startIcon={<Eye size={16} />} onClick={() => setShowCode(true)}>{t("showTransferCode")}</Button>}
          {showCode && <IconButton size="sm" variant="outline" icon={Copy} label={t("copyCode")} title={t("copyCode")}
            onClick={() => void desktopClient.copyText(me.transferCode).then(() => notify(t("codeCopied"), "success"))} />}
        </Stack>
        <form className="friendCodeForm" onSubmit={event => void transfer(event)}>
          <TextField label={t("transferCodeField")} value={transferCode} onChange={setTransferCode} autoComplete="off" spellCheck={false} />
          <Button type="submit" variant="outlined" disabled={busy || !transferCode.trim()} startIcon={<Truck size={16} />}>{t("transferAccount")}</Button>
        </form>
      </Stack>
    </Stack>
  );
};
