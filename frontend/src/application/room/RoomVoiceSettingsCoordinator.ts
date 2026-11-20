import type { RoomClient } from '../../contracts/clients';
import type { RoomVoiceSettings } from '../../contracts/models';
import type {
  RoomSessionController,
  RoomSessionScope,
} from './RoomSessionController';

interface QueuedSettingsChange {
  scope: RoomSessionScope;
  targetId: string;
  initialize: boolean;
  patch: Partial<RoomVoiceSettings>;
  edits: Map<keyof RoomVoiceSettings, number>;
  result: Promise<void>;
}

/** Publishes the singer's settings and applies room edits to that singer's existing voice chain. */
export class RoomVoiceSettingsCoordinator {
  private scope: RoomSessionScope | null = null;
  private revision = -1;
  private local: RoomVoiceSettings;
  private initializing = false;
  private tail = Promise.resolve();
  private queued?: QueuedSettingsChange;
  private readonly pending = new Map<
    keyof RoomVoiceSettings,
    { value: number; edit: number }
  >();
  private edit = 0;

  constructor(
    private readonly session: Pick<RoomSessionController, 'getScope'>,
    private readonly room: Pick<RoomClient, 'updateVoiceSettings'>,
    private readonly preferences: {
      read(): RoomVoiceSettings;
      write(settings: RoomVoiceSettings): void;
    },
    private readonly participantId: string,
  ) {
    this.local = preferences.read();
  }

  synchronize(): Promise<void> {
    const scope = this.session.getScope();
    if (scope !== this.scope) {
      this.scope = scope;
      this.revision = -1;
      this.initializing = false;
      this.pending.clear();
      this.local = this.preferences.read();
    }
    const self = scope
      ?.getRoom()
      ?.participants.find((person) => person.id === this.participantId);
    if (!scope || !self) return Promise.resolve();
    if (!self.voiceSettings) {
      if (this.initializing) return this.tail;
      this.initializing = true;
      return this.change(this.participantId, this.local, true);
    }
    if ((self.voiceSettingsRevision ?? 0) <= this.revision)
      return Promise.resolve();
    this.revision = self.voiceSettingsRevision ?? 0;
    this.local = { ...self.voiceSettings };
    for (const [key, pending] of this.pending) this.local[key] = pending.value;
    this.preferences.write(this.local);
    return Promise.resolve();
  }

  preferencesChanged(): Promise<void> {
    const values = this.preferences.read();
    const patch: Partial<RoomVoiceSettings> = {};
    for (const key of Object.keys(values) as (keyof RoomVoiceSettings)[])
      if (values[key] !== this.local[key]) patch[key] = values[key];
    this.local = values;
    return Object.keys(patch).length && this.scope?.isCurrent()
      ? this.change(this.participantId, patch)
      : Promise.resolve();
  }

  change(
    targetId: string,
    patch: Partial<RoomVoiceSettings>,
    initialize = false,
  ): Promise<void> {
    const scope = this.scope;
    if (!scope?.isCurrent()) return Promise.resolve();
    // A drag keeps one latest patch behind the request already in flight. Other singers and
    // initialization keep their position in the queue; an executing request is never changed.
    const previous = this.queued;
    const queued: QueuedSettingsChange =
      previous?.scope === scope &&
      previous.targetId === targetId &&
      !previous.initialize &&
      !initialize
        ? previous
        : {
            scope,
            targetId,
            initialize,
            patch: {},
            edits: new Map(),
            result: this.tail,
          };
    const edit = ++this.edit;
    for (const key of Object.keys(patch) as (keyof RoomVoiceSettings)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      queued.patch[key] = value;
      if (targetId === this.participantId) {
        this.pending.set(key, { value, edit });
        queued.edits.set(key, edit);
      }
    }
    if (queued === previous) return queued.result;
    this.queued = queued;
    const clearPending = () => {
      for (const [key, sentEdit] of queued.edits)
        if (this.pending.get(key)?.edit === sentEdit) this.pending.delete(key);
    };
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (this.queued === queued) this.queued = undefined;
        if (!scope.isCurrent()) return;
        try {
          const result = await this.room.updateVoiceSettings(
            scope.code,
            targetId,
            queued.patch,
            initialize,
          );
          if (!scope.isCurrent()) return;
          clearPending();
          const updated = result.participants.find(
            (person) => person.id === targetId,
          );
          const current = scope.getRoom();
          if (!updated || !current) return;
          scope.setSnapshot({
            ...current,
            participants: current.participants.map((person) =>
              person.id === targetId &&
              (updated.voiceSettingsRevision ?? 0) >
                (person.voiceSettingsRevision ?? 0)
                ? {
                    ...person,
                    voiceSettings: updated.voiceSettings,
                    voiceSettingsRevision: updated.voiceSettingsRevision,
                  }
                : person,
            ),
          });
          await this.synchronize();
        } catch (error) {
          if (scope.isCurrent()) {
            clearPending();
            this.revision = -1;
            if (initialize) this.initializing = false;
            if (!initialize) await this.synchronize();
          }
          throw error;
        }
      });
    queued.result = this.tail;
    return this.tail;
  }
}
