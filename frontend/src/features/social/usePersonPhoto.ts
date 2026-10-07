import { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useSocial, useSocialDirectory } from "../../app/SocialProvider";

/** A person's photo as a data URL, or undefined while it loads, when they have none or it fails. */
export const usePersonPhoto = (
  accountId: string | undefined,
  avatarVersion: number,
): string | undefined => {
  const { preferences } = useApp("preferences");
  const inbox = useSocial();
  const directory = useSocialDirectory();
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
    directory.avatar(accountId, avatarVersion).then(
      (url) => active && setPhoto(url),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [accountId, avatarVersion, savedPhoto, directory]);
  return photo;
};
