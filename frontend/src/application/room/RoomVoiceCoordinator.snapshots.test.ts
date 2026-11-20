import { expect, it, vi } from 'vitest';
import { roomServerMixParticipantId } from '../../contracts/clients';
import type { RoomStateDto } from '../../contracts/models';
import { RoomSessionController } from './RoomSessionController';
import { RoomRecoveryCoordinator } from './RoomRecoveryCoordinator';
import { RoomVoiceCoordinator } from './RoomVoiceCoordinator';

const versioned = (snapshotRevision: number, guest: boolean): RoomStateDto => ({
  code: 'A',
  snapshotRevision,
  hostId: 'self',
  role: 'host',
  playbackLocked: false,
  connectionStatus: 'connected',
  participants: (guest ? ['self', 'guest'] : ['self']).map((id) => ({
    id,
    name: id,
    role: id === 'self' ? 'host' : 'participant',
    self: id === 'self',
    connected: true,
    muted: false,
    volume: 2,
    readiness: 'ready',
  })),
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};

const voiceAudio = () => {
  const nativeRemotes = new Set<string>();
  const unexpected = () => {
    throw new Error('Unexpected unrelated audio operation');
  };
  const audio = {
    joinVoiceSession: async () => undefined,
    leaveVoiceSession: async () => undefined,
    synchronizeRoomClock: async () => undefined,
    setRoomPlayoutDelay: async () => undefined,
    addRemoteParticipant: vi.fn(async (id: string) => {
      nativeRemotes.add(id);
    }),
    removeRemoteParticipant: vi.fn(async (id: string) => {
      nativeRemotes.delete(id);
    }),
    microphoneEnabled: () => true,
    setMicrophoneEnabled: unexpected,
    playTestSound: unexpected,
    roomLevels: unexpected,
    roomTiming: unexpected,
    reconnectVoiceSession: unexpected,
    participantMuted: unexpected,
    participantVolume: unexpected,
    setParticipantMuted: unexpected,
    setParticipantVolume: unexpected,
    setParticipantEffect: unexpected,
    monitoringEnabled: unexpected,
    setMonitoring: unexpected,
    snapshot: unexpected,
  };
  return { audio, nativeRemotes };
};

const sessionFor = (audio: ReturnType<typeof voiceAudio>['audio']) =>
  new RoomSessionController(
    {
      createRoom: async () => versioned(1, false),
      joinRoom: async () => versioned(1, false),
      leaveRoom: async () => undefined,
      closeRoom: async () => undefined,
    },
    audio,
    'self',
  );

const setup = (guest: boolean) => {
  const { audio, nativeRemotes } = voiceAudio();
  const session = sessionFor(audio);
  session.setSnapshot(versioned(1, guest));
  const scope = session.getScope()!;
  const voice = new RoomVoiceCoordinator(scope, audio, 'self');
  const synchronization = vi.spyOn(voice, 'synchronize');
  let deliver!: (snapshot: RoomStateDto) => void;
  const applied = vi.fn();
  const recovery = new RoomRecoveryCoordinator(scope, {
    room: {
      watchRoom: (_code, callback) => {
        deliver = callback;
        return () => undefined;
      },
    },
    audio,
    voice,
    python: { listSongs: async () => [] },
    project: { reconcileReadiness: async () => undefined },
    launch: {
      selectionChanged: vi.fn(),
      recordPlaybackTransition: applied,
      observe: vi.fn(),
      stop: vi.fn(),
    },
    notify: vi.fn(),
    chime: vi.fn(),
  });
  recovery.start();
  return {
    audio,
    nativeRemotes,
    session,
    voice,
    synchronization,
    applied,
    deliver,
    stop: () => {
      recovery.stop();
      voice.stop();
    },
  };
};

const holdOperation = (
  audio: ReturnType<typeof voiceAudio>['audio'],
  operation: 'add' | 'remove',
) => {
  const started = deferred();
  const complete = deferred();
  const method =
    audio[
      operation === 'add' ? 'addRemoteParticipant' : 'removeRemoteParticipant'
    ];
  const original = method.getMockImplementation()!;
  method.mockImplementationOnce(async (id) => {
    started.resolve();
    await complete.promise;
    await original(id);
  });
  return { started: started.promise, complete: complete.resolve };
};

it.each(['add', 'remove'] as const)(
  'reconciles the newest snapshot after an obsolete native %s completes',
  async (operation) => {
    const state = setup(operation === 'remove');
    const initial = state.session.getRoom()!;
    await state.voice.synchronize(initial, initial);
    const held = holdOperation(state.audio, operation);
    try {
      state.deliver(versioned(2, operation === 'add'));
      await held.started;
      const latest = versioned(3, operation === 'remove');
      state.session.setSnapshot(latest);
      state.deliver(latest);
      held.complete();
      await vi.waitFor(() => expect(state.applied).toHaveBeenCalledOnce());
      expect(state.applied.mock.calls[0]?.[1].snapshotRevision).toBe(3);
      const expected =
        operation === 'remove' ? [roomServerMixParticipantId] : [];
      expect([...state.nativeRemotes]).toEqual(expected);
      expect(state.voice.registeredParticipants()).toEqual(expected);
      expect(state.audio.addRemoteParticipant).toHaveBeenCalledTimes(
        operation === 'remove' ? 2 : 1,
      );
      expect(state.audio.removeRemoteParticipant).toHaveBeenCalledOnce();
    } finally {
      held.complete();
      state.stop();
    }
  },
);

it.each(['stop', 'replace room'] as const)(
  'does not revive registration after %s while native add is pending',
  async (ending) => {
    const state = setup(false);
    const held = holdOperation(state.audio, 'add');
    try {
      state.deliver(versioned(2, true));
      await held.started;
      const syncing = state.synchronization.mock.results[0]
        ?.value as Promise<void>;
      if (ending === 'stop') state.stop();
      else {
        state.session.setSnapshot(null);
        state.session.setSnapshot({ ...versioned(1, false), code: 'B' });
      }
      held.complete();
      await syncing;
      expect(state.voice.registeredParticipants()).toEqual([]);
      expect(state.applied).not.toHaveBeenCalled();
      expect(state.session.getRoom()?.code).toBe(ending === 'stop' ? 'A' : 'B');
    } finally {
      held.complete();
      state.stop();
    }
  },
);
