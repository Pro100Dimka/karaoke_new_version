import {
  Card,
  FilePicker,
  Landscape,
  Stack,
  TextField,
} from "@neo-ui-kit/react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useSocial, useSocialDirectory } from "../../app/SocialProvider";
import { useText } from "../../i18n/useText";
import { avatarFromFile } from "./avatarImage";
import "./social.css";
import { usePersonPhoto } from "./usePersonPhoto";
import { useSocialAction } from "./useSocialAction";
/** The profile photo is kept with the rest of this computer's persisted profile. */
export const ProfileSettings = () => {
  const t = useText();
  const notify = useNotify();
  const inbox = useSocial();
  const directory = useSocialDirectory();
  const { preferences, updatePreferences } = useApp("preferences");
  const { busy, run } = useSocialAction();
  const me = inbox.type === "inbox" ? inbox.me : undefined;
  // The saved photo, so it is still there when Settings is opened again.
  const photo = usePersonPhoto(me?.accountId, me?.avatarVersion ?? 0);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    let photo: { mime: string; data: string };
    try {
      photo = await avatarFromFile(file);
    } catch {
      notify(t("photoUnreadable"), "error");
      return;
    }
    if (!me) return;
    if (
      await run(
        () => directory.setAvatar(photo.mime, photo.data),
        t("photoSaved"),
      )
    ) {
      updatePreferences({
        profilePhoto: `data:${photo.mime};base64,${photo.data}`,
      });
    }
  };

  return (
    <Card
      border
      padding="none"
      className="profileCard"
      icon="user"
      title={t("profile")}
    >
      <Landscape className="profileLandscape">
        <Stack direction="row" gap={4} align="center" wrap style={{ flex: 1 }}>
          <FilePicker
            variant="avatar"
            src={photo}
            name={preferences.displayName || me?.displayName}
            accept="image/*"
            size="lg"
            disabled={busy || !me}
            onFiles={(files) => choose(files?.[0])}
          />
          <TextField
            label={t("displayName")}
            value={preferences.displayName}
            onValueChange={(displayName) => updatePreferences({ displayName })}
            maxLength={48}
            disabled={busy || !me}
            style={{ flex: 1 }}
          />
        </Stack>
      </Landscape>
    </Card>
  );
};
