import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { RoomPersonCard } from '../../features/room/RoomPersonCard';
import type { RoomSessionScope } from './RoomSessionController';
import { RoomVoiceCoordinator } from './RoomVoiceCoordinator';
import { RoomVoiceSettingsCoordinator } from './RoomVoiceSettingsCoordinator';
import type { RoomStateDto, RoomVoiceSettings } from '../../contracts/models';
import { store } from '../../providers/store';

const uiSettings = vi.hoisted(() => ({
  change: vi.fn(async (): Promise<void> => undefined),
  participantVolume: vi.fn(() => 2),
  setParticipantVolume: vi.fn(async (): Promise<void> => undefined),
  participantMuted: vi.fn(() => false),
  microphoneEnabled: vi.fn(() => true),
  notify: vi.fn(),
}));
vi.mock('../../providers/application', () => ({
  useRoomVoice: () => uiSettings,
  roomVoiceSettings: uiSettings,
}));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => uiSettings.notify,
}));

it('keeps rapid personal volume movements without changing the singer settings', async () => {
  const releases: (() => void)[] = [];
  uiSettings.setParticipantVolume.mockImplementation(
    () => new Promise<void>((resolve) => releases.push(resolve)),
  );
  const participant = {
    id: 'other',
    name: 'Singer',
    role: 'participant' as const,
    self: false,
    connected: true,
    muted: false,
    volume: 1,
    readiness: 'ready' as const,
    voiceSettings: {
      echo: 0,
      reverb: 0,
      delay: 0.24,
      autoTune: 0,
      noiseSuppression: 0,
      voiceGain: 0.68,
    },
  };
  const props = {
    participant,
    hostControls: false,
    onTransferHost: vi.fn(),
    onRemove: vi.fn(),
  };
  const view = render(createElement(RoomPersonCard, props));
  const knob = screen.getByRole('slider');
  for (let index = 0; index < 3; index++)
    fireEvent.keyDown(knob, { key: 'ArrowUp' });
  expect(Number(knob.getAttribute('aria-valuenow'))).toBeCloseTo(2.03);
  view.rerender(
    createElement(RoomPersonCard, {
      ...props,
      participant: {
        ...participant,
        voiceSettings: { ...participant.voiceSettings, voiceGain: 0.69 },
      },
    }),
  );
  expect(Number(knob.getAttribute('aria-valuenow'))).toBeCloseTo(2.03);
  view.rerender(
    createElement(RoomPersonCard, {
      ...props,
      participant: {
        ...participant,
        voiceSettings: { ...participant.voiceSettings, voiceGain: 0.71 },
      },
    }),
  );
  await act(async () => {
    releases.forEach((release) => release());
  });
  expect(Number(knob.getAttribute('aria-valuenow'))).toBeCloseTo(2.03);
  expect(uiSettings.setParticipantVolume).toHaveBeenLastCalledWith(
    'other',
    2.03,
  );
  expect(uiSettings.change).not.toHaveBeenCalled();
  cleanup();
  const previous = store.preferences.voiceGain;
  store.updatePreferences({ voiceGain: 2 });
  render(
    createElement(RoomPersonCard, {
      ...props,
      participant: { ...participant, self: true },
    }),
  );
  const ownKnob = screen.getByRole('slider');
  expect(Number(ownKnob.getAttribute('aria-valuenow'))).toBe(2);
  fireEvent.keyDown(ownKnob, { key: 'ArrowUp' });
  expect(store.preferences.voiceGain).toBeCloseTo(2.01);
  act(() => store.updatePreferences({ voiceGain: 3 }));
  expect(Number(ownKnob.getAttribute('aria-valuenow'))).toBe(3);
  cleanup();
  store.updatePreferences({ voiceGain: previous });
});

const setup = () => {
  let active = true;
  const scope: RoomSessionScope = {
    code: 'A',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => active,
    getRoom: () => null,
    setSnapshot: () => false,
    disconnect: () => false,
  };
  const audio = {
    microphoneEnabled: vi.fn(() => true),
    participantMuted: vi.fn(() => false),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    setParticipantMuted: vi.fn(async () => undefined),
    setParticipantVolume: vi.fn(async () => undefined),
    setParticipantEffect: vi.fn(async () => undefined),
    monitoringEnabled: vi.fn(() => false),
    setMonitoring: vi.fn(async () => ({ monitoring: true })),
    roomTiming: vi.fn(async () => ({ roundTripMs: 10, remotes: {} })),
  };
  return {
    scope,
    audio,
    voice: new RoomVoiceCoordinator(scope, audio as never, 'self'),
    leave: () => {
      active = false;
    },
  };
};

it("does not change a participant's mixer after its room session ends", async () => {
  const { voice, audio, leave } = setup();
  leave();
  await voice.setParticipantVolume('other', 0.5);
  expect(audio.setParticipantVolume).not.toHaveBeenCalled();
});

it('restores a muted local microphone when the voice session stops', () => {
  const { voice, audio } = setup();
  audio.microphoneEnabled.mockReturnValue(false);
  voice.stop();
  expect(audio.setMicrophoneEnabled).toHaveBeenCalledWith(true);
});

const settingsSetup = () => {
  let values: RoomVoiceSettings = {
    echo: 0.1,
    reverb: 0.2,
    delay: 0.3,
    autoTune: 0.4,
    noiseSuppression: 0.5,
    voiceGain: 1.2,
  };
  let snapshot: RoomStateDto = {
    code: 'A',
    hostId: 'self',
    role: 'host',
    playbackLocked: false,
    participants: [
      {
        id: 'self',
        name: 'Self',
        role: 'host',
        self: true,
        connected: true,
        muted: false,
        volume: 1,
        readiness: 'ready',
      },
    ],
  };
  let active = true;
  const scope: RoomSessionScope = {
    code: 'A',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => active,
    getRoom: () => snapshot,
    setSnapshot: (room) => {
      snapshot = room;
      return true;
    },
    disconnect: () => false,
  };
  const updateVoiceSettings = vi.fn(
    async (_code: string, _id: string, patch: Partial<RoomVoiceSettings>) => ({
      ...snapshot,
      participants: snapshot.participants.map((person) => ({
        ...person,
        voiceSettings: { ...values, ...person.voiceSettings, ...patch },
        voiceSettingsRevision: (person.voiceSettingsRevision ?? 0) + 1,
      })),
    }),
  );
  const write = vi.fn((next: RoomVoiceSettings) => {
    values = next;
  });
  const coordinator = new RoomVoiceSettingsCoordinator(
    { getScope: () => (active ? scope : null) },
    { updateVoiceSettings },
    { read: () => values, write },
    'self',
  );
  return {
    coordinator,
    scope,
    updateVoiceSettings,
    write,
    read: () => values,
    local: (patch: Partial<RoomVoiceSettings>) => {
      values = { ...values, ...patch };
    },
    leave: () => {
      active = false;
    },
  };
};

it('retries initial publication after a network failure and rolls back a rejected setting', async () => {
  const state = settingsSetup();
  state.updateVoiceSettings.mockRejectedValueOnce(new Error('offline'));
  await expect(state.coordinator.synchronize()).rejects.toThrow('offline');
  await state.coordinator.synchronize();
  expect(state.updateVoiceSettings).toHaveBeenCalledTimes(2);
  state.updateVoiceSettings.mockRejectedValueOnce(new Error('refused'));
  state.local({ echo: 0.8 });
  await expect(state.coordinator.preferencesChanged()).rejects.toThrow(
    'refused',
  );
  expect(state.read().echo).toBe(0.1);
});

it('publishes real karaoke settings, accepts another singer edit and does not echo it back', async () => {
  const state = settingsSetup();
  await state.coordinator.synchronize();
  expect(state.updateVoiceSettings).toHaveBeenCalledWith(
    'A',
    'self',
    state.read(),
    true,
  );
  const current = state.scope.getRoom()!;
  state.scope.setSnapshot({
    ...current,
    participants: current.participants.map((person) => ({
      ...person,
      voiceSettings: { ...state.read(), echo: 0.7 },
      voiceSettingsRevision: 2,
    })),
  });
  await state.coordinator.synchronize();
  await state.coordinator.preferencesChanged();
  expect(state.read().echo).toBe(0.7);
  expect(state.updateVoiceSettings).toHaveBeenCalledTimes(1);
  state.local({ delay: 0.8 });
  await state.coordinator.preferencesChanged();
  expect(state.updateVoiceSettings).toHaveBeenLastCalledWith(
    'A',
    'self',
    { delay: 0.8 },
    false,
  );
  expect(state.read().echo).toBe(0.7);
});

it('keeps the newest local controls while older requests are pending and ignores responses after leaving', async () => {
  const state = settingsSetup();
  await state.coordinator.synchronize();
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = state.updateVoiceSettings.getMockImplementation()!;
  state.updateVoiceSettings.mockImplementationOnce(async (...args) => {
    await blocked;
    return original(...args);
  });
  state.local({ echo: 0.6 });
  const first = state.coordinator.preferencesChanged();
  state.local({ echo: 0.9 });
  const second = state.coordinator.preferencesChanged();
  release();
  await Promise.all([first, second]);
  expect(state.read().echo).toBe(0.9);
  expect(
    state.write.mock.calls.some(([settings]) => settings.echo === 0.6),
  ).toBe(false);
  state.leave();
  const calls = state.updateVoiceSettings.mock.calls.length;
  await state.coordinator.change('self', { echo: 0 });
  expect(state.updateVoiceSettings).toHaveBeenCalledTimes(calls);
});
