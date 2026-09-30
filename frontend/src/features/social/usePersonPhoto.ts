import { useEffect, useState } from "react";
import { socialClient } from "../../services/socialClient";

/** A person's photo as a data URL, or undefined while it loads, when they have none or it fails. */
export const usePersonPhoto = (accountId: string | undefined, avatarVersion: number): string | undefined => {
  const [photo, setPhoto] = useState<string>();
  useEffect(() => {
    setPhoto(undefined);
    if (!accountId || avatarVersion === 0) return;
    let active = true;
    socialClient.avatar(accountId, avatarVersion).then(
      url => active && setPhoto(url),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [accountId, avatarVersion]);
  return photo;
};
