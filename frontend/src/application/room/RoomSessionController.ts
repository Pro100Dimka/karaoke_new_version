import type { AudioServiceClient, RoomClient } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";

type RoomPort = Pick<RoomClient, "createRoom" | "joinRoom" | "leaveRoom" | "closeRoom">;
type VoicePort = Pick<AudioServiceClient, "joinVoiceSession" | "leaveVoiceSession">;

/** Server snapshots remain authoritative; these states describe only this window's participation. */
export type RoomSessionState =
  | { type: "disconnected" }
  | { type: "joining"; code?: string }
  | { type: "joined"; room: RoomStateDto }
  | { type: "recovering"; room: RoomStateDto }
  | { type: "leaving"; room: RoomStateDto }
  | { type: "failed"; error: unknown };

const cancelledJoin = (): Error => Object.assign(new Error("Room join cancelled"), { name: "AbortError" });

/** Owns one local room session and compensates partial server/voice operations. */
export class RoomSessionController {
  private state: RoomSessionState = { type: "disconnected" };
  private readonly listeners = new Set<() => void>();
  private readonly retiredCodes = new Set<string>();
  private generation = 0;
  private joining?: Promise<RoomStateDto>;
  private leaving?: Promise<void>;

  constructor(
    private readonly room: RoomPort,
    private readonly voice: VoicePort,
    private readonly participantId: string,
  ) {}

  getState = (): RoomSessionState => this.state;

  getRoom = (): RoomStateDto | null =>
    "room" in this.state ? this.state.room : null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(state: RoomSessionState): void {
    if (this.state.type === state.type &&
        "room" in this.state && "room" in state && this.state.room === state.room)
      return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** Accepts only snapshots for the active room; late responses cannot restore a departed room. */
  setSnapshot = (room: RoomStateDto | null): void => {
    if (!room) {
      const current = this.getRoom();
      if (current) this.retiredCodes.add(current.code);
      this.generation += 1;
      this.publish({ type: "disconnected" });
      return;
    }
    if (this.state.type === "joining" || this.state.type === "leaving" ||
        this.retiredCodes.has(room.code)) return;
    const current = this.getRoom();
    if (current && current.code !== room.code) return;
    this.publish(room.connectionStatus === "reconnecting"
      ? { type: "recovering", room }
      : { type: "joined", room });
  };

  join(name: string, code?: string): Promise<RoomStateDto> {
    if (this.joining) return this.joining;
    if (this.leaving) return Promise.reject(new Error("Room leave is in progress"));
    const current = this.getRoom();
    if (current)
      return code === current.code
        ? Promise.resolve(current)
        : Promise.reject(new Error("Leave the current room before joining another"));
    const generation = ++this.generation;
    this.publish({ type: "joining", code });
    const joining = (async () => {
      let joined: RoomStateDto | undefined;
      let voiceAttempted = false;
      try {
        joined = code === undefined
          ? await this.room.createRoom(name)
          : await this.room.joinRoom(code, name);
        if (generation !== this.generation) throw cancelledJoin();
        voiceAttempted = true;
        await this.voice.joinVoiceSession(
          joined.code,
          this.participantId,
          joined.serverClockOffsetMilliseconds,
        );
        if (generation !== this.generation) throw cancelledJoin();
        this.retiredCodes.delete(joined.code);
        this.publish({ type: "joined", room: joined });
        return joined;
      } catch (error) {
        if (voiceAttempted) await this.voice.leaveVoiceSession().catch(() => undefined);
        if (joined) {
          this.retiredCodes.add(joined.code);
          await this.room.leaveRoom(joined.code).catch(() => undefined);
        }
        if (generation === this.generation) this.publish({ type: "failed", error });
        throw error;
      }
    })();
    this.joining = joining;
    void joining.then(
      () => { if (this.joining === joining) this.joining = undefined; },
      () => { if (this.joining === joining) this.joining = undefined; },
    );
    return joining;
  }

  leave(): Promise<void> {
    if (this.leaving) return this.leaving;
    const current = this.getRoom();
    const generation = ++this.generation;
    if (current) {
      this.retiredCodes.add(current.code);
      this.publish({ type: "leaving", room: current });
    } else this.publish({ type: "disconnected" });
    const pendingJoin = this.joining;
    const leaving = (async () => {
      if (pendingJoin) await pendingJoin.catch(() => undefined);
      let serverError: unknown;
      if (current) {
        try { await this.room.leaveRoom(current.code); }
        catch (error) { serverError = error; }
        await this.voice.leaveVoiceSession().catch(() => undefined);
      }
      if (generation === this.generation) this.publish({ type: "disconnected" });
      if (serverError) throw serverError;
    })();
    this.leaving = leaving;
    void leaving.then(
      () => { if (this.leaving === leaving) this.leaving = undefined; },
      () => { if (this.leaving === leaving) this.leaving = undefined; },
    );
    return leaving;
  }

  close(): Promise<void> {
    if (this.leaving) return this.leaving;
    const current = this.getRoom();
    if (!current) return Promise.resolve();
    const generation = ++this.generation;
    this.publish({ type: "leaving", room: current });
    const leaving = (async () => {
      try {
        await this.room.closeRoom(current.code);
      } catch (error) {
        if (generation === this.generation) this.publish({ type: "joined", room: current });
        throw error;
      }
      this.retiredCodes.add(current.code);
      await this.voice.leaveVoiceSession().catch(() => undefined);
      if (generation === this.generation) this.publish({ type: "disconnected" });
    })();
    this.leaving = leaving;
    void leaving.then(
      () => { if (this.leaving === leaving) this.leaving = undefined; },
      () => { if (this.leaving === leaving) this.leaving = undefined; },
    );
    return leaving;
  }
}
