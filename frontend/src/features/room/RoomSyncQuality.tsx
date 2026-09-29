import type { RoomTimingReport } from "../../contracts/clients";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { Typography } from "../../theme/ui";

// Up to this voice delay everyone hears everyone as if in one room.
const closeRoomMs = 30;
// Beyond this even a follower setup struggles: the route or devices need attention.
const farRoomMs = 100;

/** Which room quality message applies to this singer's measured timing. */
export const roomQualityMessage = (timing: RoomTimingReport): MessageKey => {
  if (timing.voiceDelayMs > farRoomMs) return "roomQualityFar";
  if (timing.followMs > 0) return "roomQualityFollower";
  if (timing.voiceDelayMs > closeRoomMs) return "roomQualityNoticeable";
  return "roomQualityClose";
};

/** One line telling the singer how the room will sound for them right now. */
export const RoomSyncQuality = ({ timing }: { timing: RoomTimingReport }) => {
  const t = useText();
  const key = roomQualityMessage(timing);
  const ms = Math.round(timing.followMs || timing.voiceDelayMs);
  return (
    <Typography
      as="span"
      variant="caption"
      tone={key === "roomQualityFar" ? "danger" : "muted"}
    >
      {t(key, { ms })}
    </Typography>
  );
};
