import { useId, useRef } from "react";
import { useNotify } from "../../app/NotificationsProvider";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { Button, Card, Icon, Landscape, Stack, Typography } from "@ad-voice/ui";
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
              <Typography variant="body-sm" tone="muted">
                {t("profilePhotoHint")}
              </Typography>
              <Button
                icon="photo"
                disabled={busy || !me}
                onClick={() => picker.current?.click()}
              >
                {t("choosePhoto")}
              </Button>
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
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </Card>
  );
};
