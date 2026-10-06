import {
  Card,
  FilePicker,
  Icon,
  Landscape,
  Stack,
  TextField,
  Typography,
} from "@ad-voice/ui";
import { useId, useRef } from "react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { avatarFromFile } from "./avatarImage";
import { PersonAvatar } from "./PersonAvatar";
import "./social.css";
import { useSocial } from "./SocialContext";
import { useSocialAction } from "./useSocialAction";

/** The profile photo is kept with the rest of this computer's persisted profile. */
export const ProfileSettings = () => {
  const t = useText();
  const notify = useNotify();
  const inbox = useSocial();
  const { preferences, updatePreferences } = useApp();
  const { busy, run } = useSocialAction();
  const picker = useRef<HTMLInputElement>(null);
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
        () => socialClient.setAvatar(photo.mime, photo.data),
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
            <PersonAvatar
              size="lg"
              accountId={me?.accountId}
              avatarVersion={me?.avatarVersion ?? 0}
              name={preferences.displayName || me?.displayName || "?"}
            />
            <Stack gap={2} align="start">
              <TextField
                label={t("displayName")}
                value={preferences.displayName}
                onValueChange={(displayName) =>
                  updatePreferences({ displayName })
                }
                maxLength={48}
                disabled={busy || !me}
              />
              <FilePicker
                variant="zone"
                size="sm"
                icon="photo"
                disabled={busy || !me}
                onFiles={() => choose(picker.current?.files?.[0])}
              >
                {t("choosePhoto")}
              </FilePicker>
            </Stack>
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
