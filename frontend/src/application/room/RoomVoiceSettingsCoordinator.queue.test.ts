import { expect, it, vi } from 'vitest';
import type { RoomStateDto, RoomVoiceSettings } from '../../contracts/models';
import type { RoomSessionScope } from './RoomSessionController';
import { RoomVoiceSettingsCoordinator } from './RoomVoiceSettingsCoordinator';

const initialSettings: RoomVoiceSettings = {
  echo: 0.1,
  reverb: 0.2,
  delay: 0.3,
  autoTune: 0.4,
  noiseSuppression: 0.5,
  voiceGain: 1.2,
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const setup = (initialized = true) => {
  let values = { ...initialSettings };
  let currentScope: RoomSessionScope | null = null;
  let generation = 0;
  const rooms = new Map<string, RoomStateDto>();
  const join = (code: string, ready = true) => {
    let snapshot: RoomStateDto = {
      code,
      hostId: 'self',
      role: 'host',
      playbackLocked: false,
      participants: ['self', 'other'].map((id) => ({
        id,
        name: id,
        role: id === 'self' ? 'host' : 'participant',
        self: id === 'self',
        connected: true,
        muted: false,
        volume: 1,
        readiness: 'ready',
        ...(ready
          ? { voiceSettings: { ...initialSettings }, voiceSettingsRevision: 1 }
          : {}),
      })),
    };
    rooms.set(code, snapshot);
    const scope: RoomSessionScope = {
      code,
      generation: ++generation,
      signal: new AbortController().signal,
      isCurrent: () => currentScope === scope,
      getRoom: () => snapshot,
      setSnapshot: (next) => {
        snapshot = next;
        return true;
      },
      disconnect: () => false,
    };
    currentScope = scope;
    return scope;
  };
  join('A', initialized);
  const updateVoiceSettings = vi.fn(
    async (
      code: string,
      targetId: string,
      patch: Partial<RoomVoiceSettings>,
      initialize = false,
    ) => {
      const room = rooms.get(code)!;
      const next: RoomStateDto = {
        ...room,
        participants: room.participants.map((person) =>
          person.id !== targetId || (initialize && person.voiceSettings)
            ? person
            : {
                ...person,
                voiceSettings: {
                  ...initialSettings,
                  ...person.voiceSettings,
                  ...patch,
                },
                voiceSettingsRevision: (person.voiceSettingsRevision ?? 0) + 1,
              },
        ),
      };
      rooms.set(code, next);
      return next;
    },
  );
  const apply = updateVoiceSettings.getMockImplementation()!;
  const blockNext = () => {
    const started = deferred();
    const response = deferred();
    updateVoiceSettings.mockImplementationOnce(async (...args) => {
      started.resolve();
      await response.promise;
      return apply(...args);
    });
    return { started: started.promise, ...response };
  };
  const write = vi.fn((next: RoomVoiceSettings) => {
    values = next;
  });
  const coordinator = new RoomVoiceSettingsCoordinator(
    { getScope: () => currentScope },
    { updateVoiceSettings },
    { read: () => values, write },
    'self',
  );
  return {
    coordinator,
    updateVoiceSettings,
    blockNext,
    join,
    write,
    read: () => values,
    change: (patch: Partial<RoomVoiceSettings>) => {
      values = { ...values, ...patch };
      return coordinator.preferencesChanged();
    },
  };
};

it('sends only the latest queued fields after a slider burst behind an in-flight request', async () => {
  const state = setup();
  await state.coordinator.synchronize();
  const blocked = state.blockNext();
  const first = state.change({ echo: 0.2 });
  await blocked.started;
  const edits: Promise<void>[] = [];
  for (let index = 1; index <= 200; index++)
    edits.push(state.change({ echo: index / 200 }));
  edits.push(state.change({ reverb: 0.8 }));
  expect(state.updateVoiceSettings).toHaveBeenCalledTimes(1);
  state.write.mockClear();
  blocked.resolve();
  await Promise.all([first, ...edits]);
  expect(state.updateVoiceSettings).toHaveBeenCalledTimes(2);
  expect(state.updateVoiceSettings).toHaveBeenLastCalledWith(
    'A',
    'self',
    { echo: 1, reverb: 0.8 },
    false,
  );
  expect(state.read()).toMatchObject({ echo: 1, reverb: 0.8 });
  expect(
    state.write.mock.calls.every(([settings]) => settings.echo === 1),
  ).toBe(true);
});

it('merges a synchronous burst without crossing another participant request', async () => {
  const state = setup();
  await state.coordinator.synchronize();
  const changes = [
    state.coordinator.change('other', { echo: 0.4 }),
    state.coordinator.change('other', { reverb: 0.6 }),
    state.change({ delay: 0.7 }),
    state.coordinator.change('other', { echo: 0.9 }),
  ];
  await Promise.all(changes);
  expect(state.updateVoiceSettings.mock.calls).toEqual([
    ['A', 'other', { echo: 0.4, reverb: 0.6 }, false],
    ['A', 'self', { delay: 0.7 }, false],
    ['A', 'other', { echo: 0.9 }, false],
  ]);
});

it('publishes initialization before later edits and keeps their optimistic values', async () => {
  const state = setup(false);
  const blocked = state.blockNext();
  const initial = state.coordinator.synchronize();
  await blocked.started;
  const duplicate = state.coordinator.synchronize();
  const echo = state.change({ echo: 0.9 });
  const delay = state.change({ delay: 0.8 });
  blocked.resolve();
  await Promise.all([initial, duplicate, echo, delay]);
  expect(state.updateVoiceSettings.mock.calls).toEqual([
    ['A', 'self', initialSettings, true],
    ['A', 'self', { echo: 0.9, delay: 0.8 }, false],
  ]);
  expect(state.read()).toMatchObject({ echo: 0.9, delay: 0.8 });
  expect(
    state.write.mock.calls.every(([settings]) => settings.echo === 0.9),
  ).toBe(true);
});

it('rolls back all fields of a rejected merged edit while retaining a newer edit beyond a barrier', async () => {
  const state = setup();
  await state.coordinator.synchronize();
  const firstResponse = state.blockNext();
  const rejectedResponse = state.blockNext();
  const barrierResponse = state.blockNext();
  const first = state.change({ echo: 0.4 });
  await firstResponse.started;
  const echo = state.change({ echo: 0.7 });
  const delay = state.change({ delay: 0.8 });
  const barrier = state.coordinator.change('other', { reverb: 0.6 });
  const latest = state.change({ echo: 0.9 });
  const rejected = Promise.allSettled([echo, delay]);
  firstResponse.resolve();
  await first;
  await rejectedResponse.started;
  rejectedResponse.reject(new Error('refused'));
  await barrierResponse.started;
  expect((await rejected).map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
  ]);
  expect(state.read()).toMatchObject({ echo: 0.9, delay: 0.3 });
  barrierResponse.resolve();
  await Promise.all([barrier, latest]);
  expect(state.read()).toMatchObject({ echo: 0.9, delay: 0.3 });
  expect(state.updateVoiceSettings).toHaveBeenCalledTimes(4);
});

it('drops queued edits of a departed scope and keeps the next room independent', async () => {
  const state = setup();
  await state.coordinator.synchronize();
  const blocked = state.blockNext();
  const first = state.change({ echo: 0.4 });
  await blocked.started;
  const stale = state.change({ echo: 0.7 });
  state.join('B');
  await state.coordinator.synchronize();
  const echo = state.change({ echo: 0.9 });
  const delay = state.change({ delay: 0.8 });
  blocked.resolve();
  await Promise.all([first, stale, echo, delay]);
  expect(state.updateVoiceSettings.mock.calls).toEqual([
    ['A', 'self', { echo: 0.4 }, false],
    ['B', 'self', { echo: 0.9, delay: 0.8 }, false],
  ]);
  expect(state.read()).toMatchObject({ echo: 0.9, delay: 0.8 });
});
