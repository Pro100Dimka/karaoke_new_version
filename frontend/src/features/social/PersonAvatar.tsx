import { useEffect, useState } from "react";
import type { SocialPresence } from "../../contracts/social";
import { socialClient } from "../../services/socialClient";
import "./social.css";

const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";

/**
 * A person's photo, or their initials when they have none (or it cannot be loaded). A presence dot
 * shows whether they have the app open.
 */
export const PersonAvatar = ({
  accountId,
  avatarVersion,
  name,
  presence,
  size = "md",
}: {
  accountId?: string;
  avatarVersion: number;
  name: string;
  presence?: SocialPresence;
  size?: "sm" | "md" | "lg";
}) => {
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

  return (
    <span className={`personAvatar personAvatar--${size}`} aria-hidden>
      {photo ? <img src={photo} alt="" draggable={false} /> : <span>{initials(name)}</span>}
      {presence && <span className={`personPresence personPresence--${presence}`} />}
    </span>
  );
};
