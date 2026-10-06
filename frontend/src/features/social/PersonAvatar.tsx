import { Avatar } from "@ad-voice/ui";
import type { SocialPresence } from "../../contracts/social";
import { usePersonPhoto } from "./usePersonPhoto";

const presenceDot = {
  Online: "online",
  InRoom: "busy",
  Offline: "offline",
} as const satisfies Record<SocialPresence, string>;

/**
 * A person's photo, or their initial when they have none (or it cannot be loaded). A presence dot
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
  const photo = usePersonPhoto(accountId, avatarVersion);
  return (
    <Avatar
      size={size}
      name={name}
      src={photo}
      presence={presence && presenceDot[presence]}
    />
  );
};
