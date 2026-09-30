import { ImagePlus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useNotify } from "../../app/NotificationsProvider";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { Button, Stack, Typography } from "../../theme/ui";
import { avatarFromFile } from "./avatarImage";
import { PersonAvatar } from "./PersonAvatar";
import { useSocial } from "./SocialContext";
import { useSocialAction } from "./useSocialAction";
import "./social.css";

/** The profile photo is kept with the rest of this computer's persisted profile. */
export const ProfileSettings = () => {
  const t = useText();
  const notify = useNotify();
  const inbox = useSocial();
  const { preferences, updatePreferences } = useApp();
  const { busy, run } = useSocialAction();
  const picker = useRef<HTMLInputElement>(null);
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
    if (await run(() => socialClient.setAvatar(photo.mime, photo.data), t("photoSaved"))) {
      updatePreferences({ profilePhoto: `data:${photo.mime};base64,${photo.data}` });
    }
  };
  const clear = async () => {
    if (await run(() => socialClient.clearAvatar())) updatePreferences({ profilePhoto: "" });
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
              <Button size="sm" variant="outlined" disabled={busy} startIcon={<Trash2 size={16} />} onClick={() => void clear()}>{t("removePhoto")}</Button>
            )}
          </Stack>
        </Stack>
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
      </Stack>
    </Stack>
  );
};
