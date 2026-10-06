import { createHash, createHmac } from "node:crypto";
import { deviceSecret } from "./SocialIdentity";

/**
 * Who this app profile is in a room. The participant id everyone sees is a hash of a key that never
 * leaves this computer except to the room server, so knowing someone's id (the host's, say) is not
 * enough to act as them, take their voice slot or reconnect in their place.
 */
export const roomKeyHeader = "X-AD-Voice-Room-Key";

let key: Promise<string> | undefined;

export const roomKey = (): Promise<string> => {
  key ??= deviceSecret().then(secret => createHmac("sha256", secret).update("ad-voice-room-key").digest("hex"));
  return key;
};

/** Must match `participant_id_for` on the room server. */
export const roomParticipantIdFor = (roomKeyValue: string): string =>
  createHash("sha256").update(`ad-voice-room-participant:${roomKeyValue}`).digest("hex").slice(0, 32);

export const roomParticipantId = async (): Promise<string> => roomParticipantIdFor(await roomKey());

export const withRoomKey = async (headers: Record<string, string> = {}): Promise<Record<string, string>> => ({
  ...headers,
  [roomKeyHeader]: await roomKey(),
});
