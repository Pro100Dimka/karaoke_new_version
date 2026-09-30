import type { ReactNode } from "react";
import type { SocialPresence } from "../../contracts/social";
import { Typography } from "../../theme/ui";
import { PersonAvatar } from "./PersonAvatar";

/** One person in a list: photo, name, a line about them, and what can be done. */
export const PersonRow = ({
  accountId,
  avatarVersion = 0,
  name,
  detail,
  presence,
  actions,
}: {
  accountId?: string;
  avatarVersion?: number;
  name: string;
  detail?: string;
  presence?: SocialPresence;
  actions?: ReactNode;
}) => (
  <li className="personRow">
    <PersonAvatar accountId={accountId} avatarVersion={avatarVersion} name={name} presence={presence} />
    <span className="personRowText">
      <Typography variant="body1" className="personRowName">{name}</Typography>
      {detail && <Typography variant="body2" tone="muted">{detail}</Typography>}
    </span>
    {actions && <span className="personRowActions">{actions}</span>}
  </li>
);
