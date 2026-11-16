import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useRoomVoicePolls, roomVoicePollingFixtureState } from './roomVoicePollingFixture';
import { speakingLevelOf } from './roomSpeakingLevelsStore';
import { type RoomStateDto } from '../../contracts/models';
const { mocks } = roomVoicePollingFixtureState;
it('republishes a direct-to-relay route change even at unchanged latency', async () => {
  vi.useFakeTimers();
  const initial = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 60,
    participants: [],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const report = {
    requestedVoiceDelayMs: 26,
    packetsSent: 12000,
    packetsReceived: 24000,
    relayEchoes: 5,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {
      guest: {
        directPackets: 12000,
        relayPackets: 0,
        jitterMs: 0,
        targetDelayMs: 26,
        lateCuts: 0,
      },
    },
  };
  mocks.roomTiming.mockResolvedValue({ ...report, voiceRoute: 'direct' });
  mocks.setVoiceLatency.mockResolvedValue(initial);
  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.setVoiceLatency).toHaveBeenLastCalledWith(
      'ROOM42',
      26,
      undefined,
      true,
      'direct',
    );
    mocks.roomTiming.mockResolvedValue({ ...report, voiceRoute: 'relay' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.setVoiceLatency).toHaveBeenCalledTimes(2);
    expect(mocks.setVoiceLatency).toHaveBeenLastCalledWith(
      'ROOM42',
      26,
      undefined,
      true,
    );
  } finally {
    unmount();
    mocks.roomTiming.mockResolvedValue({ packetsSent: 0, packetsReceived: 0 });
  }
});

it('republishes timing after a device restart even when the measured latency is unchanged', async () => {
  vi.useFakeTimers();
  const initial = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 60,
    participants: [],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const report = {
    generationId: 1,
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 60,
    packetsSent: 1000,
    packetsReceived: 1000,
    relayEchoes: 5,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  };
  mocks.roomTiming.mockResolvedValue(report);
  mocks.setVoiceLatency.mockResolvedValue(initial);
  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.setVoiceLatency).toHaveBeenCalledTimes(1);
    mocks.roomTiming.mockResolvedValue({
      ...report,
      generationId: 2,
      packetsSent: 10,
      packetsReceived: 10,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.setVoiceLatency).toHaveBeenCalledTimes(1);
    mocks.roomTiming.mockResolvedValue({ ...report, generationId: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.setVoiceLatency).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    mocks.roomTiming.mockResolvedValue({ packetsSent: 0, packetsReceived: 0 });
  }
});

it('shows the server-reported microphone level on each remote participant without touching the room', async () => {
  mocks.roomLevels.mockResolvedValueOnce({
    local: 0.25,
    remote: { __room_server_mix__: 0.9 },
  });
  mocks.voiceLevels.mockResolvedValueOnce({ guest: 0.75 });
  const initial = {
    code: 'ROOM42',
    participants: [],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const setRoom = vi.fn();

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, setRoom),
  );

  await waitFor(() =>
    expect(speakingLevelOf({ id: 'guest', self: false })).toBe(0.75),
  );
  expect(speakingLevelOf({ id: 'self', self: true })).toBe(0.25);
  // The meters repaint on their own; the room (and every screen reading it) is left alone.
  expect(setRoom).not.toHaveBeenCalled();
  expect(roomRef.current).toBe(initial);
  unmount();
  expect(speakingLevelOf({ id: 'guest', self: false })).toBe(0);
});

it('refreshes the locally cached pushed levels smoothly', async () => {
  vi.useFakeTimers();
  const roomRef = {
    current: { code: 'ROOM42', participants: [] } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );
  await act(async () => {
    await Promise.resolve();
  });
  mocks.voiceLevels.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(mocks.voiceLevels).toHaveBeenCalledTimes(12);
  unmount();
});

it('does not declare voice timing ready before the relay has answered', async () => {
  const roomRef = {
    current: {
      code: 'ROOM42',
      roomPlayoutDelayMs: 10,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );

  await waitFor(() => expect(mocks.roomTiming).toHaveBeenCalled());
  expect(mocks.setVoiceLatency).not.toHaveBeenCalled();
  unmount();
});

it('publishes the first route from probe echoes before any server mix can arrive', async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 47,
    requestedVoiceDelayMs: 6,
    packetsSent: 1_000,
    packetsReceived: 0,
    relayEchoes: 2,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue(room);

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith(
      'ROOM42',
      47,
      undefined,
      false,
    ),
  );
  unmount();
});

it('immediately applies the server-selected room deadline to AudioService', async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const initial = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 60,
    participants: [],
  } as unknown as RoomStateDto;
  const updated = { ...initial, roomPlayoutDelayMs: 160 };
  mocks.setVoiceLatency.mockResolvedValue(updated);
  const roomRef = { current: initial };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setRoomPlayoutDelay).toHaveBeenCalledWith(160),
  );
  expect(roomRef.current).toEqual(updated);
  unmount();
});

it.each(['response', 'audio'])(
  'does not restore an older selection after a late timing %s',
  async (stage) => {
    mocks.roomTiming.mockResolvedValueOnce({
      estimatedVoiceLatencyMs: 55,
      packetsSent: 1000,
      packetsReceived: 1000,
      relayEchoes: 1,
      networkTransportRunning: true,
      networkSendEnabled: true,
      remotes: {},
    });
    const initial: RoomStateDto = {
      code: 'ROOM42',
      hostId: 'host',
      role: 'participant',
      participants: [],
      playbackLocked: false,
      songId: 'old',
      revision: 1,
      roomPlayoutDelayMs: 60,
    };
    const roomRef = { current: initial };
    let finish = () => {};
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.setVoiceLatency.mockImplementationOnce(async () => {
      if (stage === 'response') await blocked;
      return { ...initial, roomPlayoutDelayMs: 160 };
    });
    if (stage === 'audio')
      mocks.setRoomPlayoutDelay.mockImplementationOnce(async () => {
        await blocked;
      });
    const setRoom = vi.fn();
    const { unmount } = renderHook(() =>
      useRoomVoicePolls('ROOM42', roomRef, setRoom),
    );
    try {
      await waitFor(() =>
        expect(
          stage === 'response'
            ? mocks.setVoiceLatency
            : mocks.setRoomPlayoutDelay,
        ).toHaveBeenCalled(),
      );
      const latest = { ...initial, songId: 'new', revision: 2 };
      roomRef.current = latest;
      await act(async () => {
        finish();
        await blocked;
      });
      expect(roomRef.current).toBe(latest);
      expect(setRoom).not.toHaveBeenCalled();
      if (stage === 'response')
        expect(mocks.setRoomPlayoutDelay).not.toHaveBeenCalled();
    } finally {
      finish();
      unmount();
    }
  },
);

it('allows the explicit Electron room E2E harness to publish its diagnostic delay', async () => {
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { roomE2e: true },
  });
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue(room);

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith(
      'ROOM42',
      160,
      undefined,
      true,
    ),
  );
  unmount();
});

it('re-registers voice when microphone packets continue but relay echoes stop', async () => {
  vi.useFakeTimers();
  let packetsSent = 10;
  mocks.roomTiming.mockImplementation(async () => ({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 80,
    packetsSent: packetsSent++,
    packetsReceived: 4,
    relayEchoes: 4,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  }));
  mocks.setVoiceLatency.mockResolvedValue({
    code: 'ROOM42',
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto);
  const roomRef = {
    current: {
      code: 'ROOM42',
      roomPlayoutDelayMs: 80,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );
  await act(async () => {
    await Promise.resolve();
  });
  for (let sample = 0; sample < 4; sample += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }

  expect(mocks.reconnectVoiceSession).toHaveBeenCalledTimes(1);
  unmount();
  vi.useRealTimers();
});

it('keeps a healthy voice session when relay echoes continue', async () => {
  vi.useFakeTimers();
  let sample = 0;
  mocks.roomTiming.mockImplementation(async () => ({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 80,
    packetsSent: 10 + sample,
    packetsReceived: 4 + sample,
    relayEchoes: 4 + sample++,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  }));
  mocks.setVoiceLatency.mockResolvedValue({
    code: 'ROOM42',
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto);
  const roomRef = {
    current: {
      code: 'ROOM42',
      roomPlayoutDelayMs: 80,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', roomRef, vi.fn()),
  );
  await act(async () => {
    await Promise.resolve();
  });
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }

  expect(mocks.reconnectVoiceSession).not.toHaveBeenCalled();
  unmount();
  vi.useRealTimers();
});
