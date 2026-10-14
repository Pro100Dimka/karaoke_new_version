import {
  Card,
  FilePicker,
  Icon,
  Landscape,
  Stack,
  TextField,
  ThemePicker,
  Typography,
  type FormApi,
} from "@neo-ui-kit/react";
import { useId } from "react";
import { useApp } from "../../app/AppContext";
import { appThemes } from "../../app/appTheme";
import { useNotify } from "../../app/NotificationsProvider";
import { useSocial, useSocialDirectory } from "../../app/SocialProvider";
import type { ThemeName } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { SettingsFormValues } from "../settings/settingsForm";
import { themeOptions } from "../settings/tabs/Appearance/consts";
import { avatarFromFile } from "./avatarImage";
import "./social.css";
import { usePersonPhoto } from "./usePersonPhoto";
import { useSocialAction } from "./useSocialAction";
/** The profile photo is kept with the rest of this computer's persisted profile. */
export const ProfileSettings = ({
  form,
}: {
  form: FormApi<SettingsFormValues>;
}) => {
  const t = useText();
  const notify = useNotify();
  const inbox = useSocial();
  const directory = useSocialDirectory();
  const { preferences, updatePreferences } = useApp("preferences");
  const { busy, run } = useSocialAction();
  const titleId = useId();
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
      aria-labelledby={titleId}
    >
      <Landscape className="profileLandscape">
        <Stack direction="row" gap="1rem" style={{ flex: 1 }}>
          <Stack gap="0.75rem" aria-labelledby={titleId}>
            <Typography as="h2" variant="title" weight="bold" id={titleId}>
              {t("profile")}
            </Typography>
            <Stack direction="row" gap={4} align="center" wrap>
              <FilePicker
                variant="avatar"
                src={photo}
                name={preferences.displayName || me?.displayName}
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
          <Stack direction="row" gap="1rem" style={{ flex: 1, width: "auto" }}>
            <ThemePicker<ThemeName>
              label={t("theme")}
              value={form.values.theme}
              style={{ flex: 1, width: "auto" }}
              onValueChange={(theme) => form.setValue("theme", theme)}
              options={themeOptions.map((option) => ({
                value: option.value,
                label: t(option.label),
                description: t(option.description),
                image: appThemes[option.value].icon,
                color: option.color,
              }))}
            />
          </Stack>
        </Stack>
      </Landscape>
    </Card>
  );
};
