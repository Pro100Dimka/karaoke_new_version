import type { RoomStateDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";
import { participantId } from "../../services/roomMappers";

/**
 * Creates a room (no code) or joins one, and opens this participant's voice in it. A room whose
 * voice cannot open is left again, so nobody sits in a room they cannot hear.
 */
export const enterRoom = async (
  name: string,
  code?: string,
): Promise<RoomStateDto> => {
  const room =
    code === undefined
      ? await roomClient.createRoom(name)
      : await roomClient.joinRoom(code, name);
  try {
    await audioClient.joinVoiceSession(
      room.code,
      participantId,
      room.serverClockOffsetMilliseconds,
    );
  } catch (error) {
    await roomClient.leaveRoom(room.code).catch(() => undefined);
    throw error;
  }
  return room;
};

/** Leaves a room quietly (the server hands a host's room to someone else) and closes the voice. */
export const leaveRoom = async (code: string): Promise<void> => {
  await roomClient.leaveRoom(code).catch(() => undefined);
  await audioClient.leaveVoiceSession().catch(() => undefined);
};
