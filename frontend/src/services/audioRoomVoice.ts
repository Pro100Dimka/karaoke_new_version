import { desktopBridge } from "./desktopBridge";
import type { AudioServiceClient } from "../contracts/clients";
import type { RequestedAudioConfiguration, RuntimeAudioConfiguration } from "../contracts/models";
import { backendName, diagnosticNumber, roomTimingFromDiagnostics } from "./audioProtocol";
import { audioClock, audioState, command, diagnostics, ensureSession, refreshClock } from "./audioSession";
import { roomServerMixParticipantId } from "../features/room/roomModel";

type RemoteEffect = "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune";

interface VoiceSession {
  roomId: string;
  participantId: string;
  serverClockOffsetMilliseconds?: number;
}

/** The highest server deadline a room may ask for. */
const maximumRoomPlayoutDelayMilliseconds = 160;

interface VoiceState {
  session: VoiceSession | null;
  /** One server-owned deadline for backing audio and every remote voice in the active room. */
  roomPlayoutDelayMilliseconds: number;
  /** Personal volumes, keyed by participant (the server mix is one of them). */
  gains: Map<string, number>;
  effects: Map<string, Map<RemoteEffect, number>>;
  muted: Set<string>;
}

const voice: VoiceState = {
  session: null,
  roomPlayoutDelayMilliseconds: 0,
  gains: new Map(),
  effects: new Map(),
  muted: new Set(),
};

const forgetParticipant = (participantId: string) => {
  voice.gains.delete(participantId);
  voice.muted.delete(participantId);
};

/** A person's personal volume lives in the server mix-minus, so it is replayed to the relay. */
const restoreRelayGain = async (participantId: string, gain: number): Promise<void> => {
  const setGain = desktopBridge().setRoomVoiceParticipantGain;
  if (!setGain) {
    forgetParticipant(participantId);
    return;
  }
  try {
    await setGain(participantId, voice.muted.has(participantId) ? 0 : gain);
  } catch {
    // A remembered person may belong to an old room. Their preference is local and must not
    // prevent the new room voice session from reconnecting.
    forgetParticipant(participantId);
  }
};

/** The server mix itself is one AudioService participant, with its gain, effects and mute. */
const restoreServerMix = async (participantId: string, gain: number): Promise<void> => {
  await command("AddRemoteParticipant", { participantId });
  await command("SetRemoteGain", { participantId, value: gain });
  for (const [effect, value] of voice.effects.get(participantId) ?? [])
    await command("SetRemoteEffect", { participantId, effect, value });
  if (voice.muted.has(participantId))
    await command("SetRemoteMute", { participantId, muted: true });
};

const restoreRemoteParticipants = async (): Promise<void> => {
  if (voice.session && !voice.gains.has(roomServerMixParticipantId))
    voice.gains.set(roomServerMixParticipantId, 1);
  for (const [participantId, gain] of voice.gains) {
    if (participantId === roomServerMixParticipantId) await restoreServerMix(participantId, gain);
    else await restoreRelayGain(participantId, gain);
  }
};

export const synchronizeRoomClock = async (offset?: number, force = false): Promise<void> => {
  if (offset === undefined || !Number.isFinite(offset)) return;
  if (!force && voice.session?.serverClockOffsetMilliseconds === offset) return;
  await diagnostics();
  await refreshClock();
  const clock = audioClock();
  if (!clock) throw new Error("AudioService clock is unavailable");
  const now = performance.now();
  await command("SetRoomClock", {
    serverMicros: Math.round((now + offset) * 1000),
    localMicros: Math.round((now + clock.offset) * 1000),
  });
  if (voice.session) voice.session.serverClockOffsetMilliseconds = offset;
};

/** Rejoins the room's voice after AudioService restarted or changed its endpoints. */
export const restoreVoiceSession = async (): Promise<void> => {
  const session = voice.session;
  if (!session) return;
  await ensureSession();
  await synchronizeRoomClock(session.serverClockOffsetMilliseconds, true);
  await desktopBridge().joinRoomVoice(session.roomId, session.participantId);
  await restoreRemoteParticipants();
  await command("SetRoomPlayoutDelay", { milliseconds: voice.roomPlayoutDelayMilliseconds });
};

type RoomVoiceMethods = Pick<
  AudioServiceClient,
  | "setParticipantMuted"
  | "participantMuted"
  | "setParticipantVolume"
  | "roomLevels"
  | "setParticipantEffect"
  | "roomTiming"
  | "synchronizeRoomClock"
  | "setRoomPlayoutDelay"
  | "joinVoiceSession"
  | "reconnectVoiceSession"
  | "leaveVoiceSession"
  | "addRemoteParticipant"
  | "removeRemoteParticipant"
>;

export const createRoomVoice = (
  applyConfiguration: (configuration: RequestedAudioConfiguration) => Promise<RuntimeAudioConfiguration>,
): RoomVoiceMethods => ({
  async setParticipantMuted(participantId, muted) {
    const gain = muted ? 0 : (voice.gains.get(participantId) ?? 1);
    await desktopBridge().setRoomVoiceParticipantGain(participantId, gain);
    if (muted) voice.muted.add(participantId);
    else voice.muted.delete(participantId);
  },

  participantMuted: (participantId) => voice.muted.has(participantId),

  async setParticipantVolume(participantId, gain) {
    voice.gains.set(participantId, gain);
    await desktopBridge().setRoomVoiceParticipantGain(
      participantId,
      voice.muted.has(participantId) ? 0 : gain,
    );
  },

  async roomLevels() {
    const values = await diagnostics();
    const remote: Record<string, number> = {};
    for (const [name, value] of Object.entries(values)) {
      if (name.startsWith("RemoteLevel.")) remote[name.slice("RemoteLevel.".length)] = diagnosticNumber(value);
    }
    return { local: diagnosticNumber(values.InputRMS), remote };
  },

  async setParticipantEffect(participantId, effect, value) {
    const effects = voice.effects.get(participantId) ?? new Map<RemoteEffect, number>();
    effects.set(effect, value);
    voice.effects.set(participantId, effects);
    await command("SetRemoteEffect", { participantId, effect, value });
  },

  async roomTiming() {
    return roomTimingFromDiagnostics(await diagnostics());
  },

  synchronizeRoomClock,

  async setRoomPlayoutDelay(milliseconds) {
    const bounded = Math.max(0, Math.min(maximumRoomPlayoutDelayMilliseconds, milliseconds));
    if (bounded === voice.roomPlayoutDelayMilliseconds) return;
    await command("SetRoomPlayoutDelay", { milliseconds: bounded });
    voice.roomPlayoutDelayMilliseconds = bounded;
  },

  async joinVoiceSession(roomId, participantId, serverClockOffsetMilliseconds) {
    await ensureSession();
    // A session left running in another mode (an earlier start-up, device failure or rolled-back
    // switch) would carry the room on that mode's latency; the chosen mode is restored first.
    // If the device refuses it, the room still opens on the mode that works.
    const running = (await diagnostics()).Backend;
    if (running !== undefined && backendName(running) !== audioState.preferred.backend) {
      const selected = audioState.preferred;
      await applyConfiguration(selected).catch(() => {
        // A temporary device failure may keep the room on its working fallback, but it must not
        // turn that fallback into the user's selection. A later join/recovery retries ASIO.
        audioState.preferred = selected;
      });
    }
    await synchronizeRoomClock(serverClockOffsetMilliseconds, true);
    await desktopBridge().joinRoomVoice(roomId, participantId);
    voice.session = { roomId, participantId, serverClockOffsetMilliseconds };
    await restoreRemoteParticipants();
  },

  async reconnectVoiceSession() {
    await restoreVoiceSession();
  },

  async leaveVoiceSession() {
    await desktopBridge().leaveRoomVoice();
    voice.session = null;
    if (voice.roomPlayoutDelayMilliseconds > 0)
      await command("SetRoomPlayoutDelay", { milliseconds: 0 });
    voice.roomPlayoutDelayMilliseconds = 0;
    voice.gains.clear();
    voice.effects.clear();
    voice.muted.clear();
  },

  async addRemoteParticipant(participantId) {
    await command("AddRemoteParticipant", { participantId });
    if (!voice.gains.has(participantId)) voice.gains.set(participantId, 1);
  },

  async removeRemoteParticipant(participantId) {
    await command("RemoveRemoteParticipant", { participantId });
    voice.gains.delete(participantId);
    voice.effects.delete(participantId);
  },
});
