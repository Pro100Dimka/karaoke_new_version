import {
  Card,
  FilePicker,
  Icon,
  Landscape,
  Stack,
  TextField,
  Typography,
} from "@ad-voice/ui";
import { useId } from "react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useText } from "../../i18n/useText";
import { avatarFromFile } from "./avatarImage";
import "./social.css";
import { useSocial, useSocialDirectory } from "../../app/SocialProvider";
import { useSocialAction } from "./useSocialAction";

/** The profile photo is kept with the rest of this computer's persisted profile. */
export const ProfileSettings = () => {
  const t = useText();
  const notify = useNotify();
  const inbox = useSocial();
  const directory = useSocialDirectory();
  const { preferences, updatePreferences } = useApp("preferences");
  const { busy, run } = useSocialAction();
  const titleId = useId();
  const me = inbox.type === "inbox" ? inbox.me : undefined;

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
      aria-labelledby={titleId}
    >
      <Landscape className="profileLandscape">
        <Stack gap="0.75rem">
          <Typography as="h2" variant="title" weight="bold" id={titleId}>
            {t("profile")}
          </Typography>
          <Stack direction="row" gap={4} align="center" wrap>
            <FilePicker
              variant="avatar"
              accept="image/*"
              size="sm"
              disabled={busy || !me}
              onFiles={(files) => choose(files?.[0])}
            />
            <TextField
              label={t("displayName")}
              value={preferences.displayName}
              onValueChange={(displayName) =>
                updatePreferences({ displayName })
              }
              maxLength={48}
              disabled={busy || !me}
            />
          </Stack>
          <div className="profileSlogan" aria-hidden="true">
            <span>
              {t("profileSlogan")} <Icon name="heart" />
            </span>
            <small>{t("profileSloganHint")}</small>
          </div>
        </Stack>
      </Landscape>
    </Card>
  );
};
