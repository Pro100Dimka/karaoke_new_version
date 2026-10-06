import { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import { socialClient } from "../../services/socialClient";
import { useSocial } from "./SocialContext";

/** A person's photo as a data URL, or undefined while it loads, when they have none or it fails. */
export const usePersonPhoto = (
  accountId: string | undefined,
  avatarVersion: number,
): string | undefined => {
  const { preferences } = useApp();
  const inbox = useSocial();
  const savedPhoto =
    inbox.type === "inbox" && accountId === inbox.me.accountId
      ? preferences.profilePhoto || undefined
      : undefined;
  const [photo, setPhoto] = useState<string | undefined>(savedPhoto);
  useEffect(() => {
    setPhoto(savedPhoto);
    if (savedPhoto) return;
    if (!accountId || avatarVersion === 0) return;
    let active = true;
    socialClient.avatar(accountId, avatarVersion).then(
      (url) => active && setPhoto(url),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [accountId, avatarVersion, savedPhoto]);
  return photo;
};
