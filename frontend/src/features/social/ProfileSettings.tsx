import { Heart, ImagePlus } from "lucide-react";
import { useId, useRef } from "react";
import { useNotify } from "../../app/NotificationsProvider";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { Button } from "../../theme/ui";
import { SettingsNeonFrame } from "../settings/SettingsNeonFrame";
import { ProfileLandscape } from "../settings/tabs/Appearance/ProfileLandscape";
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
    if (await run(() => socialClient.setAvatar(photo.mime, photo.data), t("photoSaved"))) {
      updatePreferences({ profilePhoto: `data:${photo.mime};base64,${photo.data}` });
    }
  };

  return (
    <section className="appearanceCard appearanceProfile" aria-labelledby={titleId}>
      <SettingsNeonFrame order={0} />
      <div className="appearanceProfileArt" aria-hidden="true">
        <ProfileLandscape />
        <span className="appearanceProfileShade" />
      </div>
      <h2 id={titleId}>{t("profile")}</h2>
      <span className="appearanceAvatar">
        <PersonAvatar
          size="lg"
          accountId={me?.accountId}
          avatarVersion={me?.avatarVersion ?? 0}
          name={preferences.displayName || me?.displayName || "?"}
        />
      </span>
      <p className="appearanceProfileNote">{t("profilePhotoHint")}</p>
      <Button
        className="appearanceGlassButton appearancePhotoButton"
        disabled={busy || !me}
        startIcon={<ImagePlus />}
        onClick={() => picker.current?.click()}
      >
        {t("choosePhoto")}
      </Button>
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
      <div className="appearanceHeroSlogan" aria-hidden="true">
        <div>BE YOURSELF <Heart /></div>
        <small>MUSIC CONNECTS PEOPLE</small>
      </div>
    </section>
  );
};
