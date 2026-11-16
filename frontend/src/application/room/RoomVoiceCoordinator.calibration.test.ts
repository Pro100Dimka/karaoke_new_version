import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useRoomVoicePolls, roomVoicePollingFixtureState } from './roomVoicePollingFixture';
import { type RoomStateDto } from '../../contracts/models';
const { mocks } = roomVoicePollingFixtureState;
it('waits for the direct observation window instead of calibrating from backup packets', async () => {
  vi.useFakeTimers();
  const initial = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 250,
    participants: [],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const report = {
    voiceRoute: 'direct' as const,
    estimatedVoiceLatencyMs: 26,
    requestedVoiceDelayMs: 96,
    packetsSent: 24000,
    packetsReceived: 48000,
    relayEchoes: 5,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {
      guest: {
        directPackets: 800,
        relayPackets: 0,
        jitterMs: 0,
        targetDelayMs: 250,
        lateCuts: 0,
      },
    },
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
    expect(mocks.setVoiceLatency).toHaveBeenLastCalledWith(
      'ROOM42',
      26,
      undefined,
      false,
      'direct',
    );
    mocks.roomTiming.mockResolvedValue({
      ...report,
      remotes: { guest: { ...report.remotes.guest, directPackets: 12000 } },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.setVoiceLatency).toHaveBeenLastCalledWith(
      'ROOM42',
      96,
      undefined,
      true,
      'direct',
    );
  } finally {
    unmount();
    mocks.roomTiming.mockResolvedValue({ packetsSent: 0, packetsReceived: 0 });
  }
});

it.each([
  ['BOOTSTRAP', 2000],
  ['SHORT_WINDOW', 6000],
  ['STABLE_HISTORY', 72000],
] as const)(
  'publishes the measured direct %s requirement without waiting thirty seconds',
  async (requirementSource, directPackets) => {
    vi.useFakeTimers();
    const initial = {
      code: 'ROOM42',
      roomPlayoutDelayMs: 250,
      participants: [],
    } as unknown as RoomStateDto;
    const roomRef = { current: initial };
    const report = {
      voiceRoute: 'direct' as const,
      requirementSource,
      estimatedVoiceLatencyMs: 26,
      requestedVoiceDelayMs: 44,
      packetsSent: 6000,
      packetsReceived: 12000,
      relayEchoes: 5,
      networkTransportRunning: true,
      networkSendEnabled: true,
      remotes: {
        guest: {
          directPackets,
          relayPackets: 0,
          jitterMs: 0,
          targetDelayMs: 250,
          lateCuts: 0,
        },
      },
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
      expect(mocks.setVoiceLatency).toHaveBeenLastCalledWith(
        'ROOM42',
        44,
        undefined,
        true,
        'direct',
      );
    } finally {
      unmount();
      mocks.roomTiming.mockResolvedValue({
        packetsSent: 0,
        packetsReceived: 0,
      });
    }
  },
);

it('does not calibrate an unknown native direct route from old packet counters', async () => {
  vi.useFakeTimers();
  const initial = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 250,
    participants: [],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const report = {
    voiceRoute: 'direct' as const,
    requirementSource: 'UNKNOWN' as const,
    estimatedVoiceLatencyMs: 26,
    requestedVoiceDelayMs: 0,
    packetsSent: 24000,
    packetsReceived: 48000,
    relayEchoes: 5,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {
      guest: {
        directPackets: 24000,
        relayPackets: 0,
        jitterMs: 0,
        targetDelayMs: 250,
        lateCuts: 0,
      },
    },
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
    expect(mocks.setVoiceLatency).toHaveBeenLastCalledWith(
      'ROOM42',
      26,
      undefined,
      false,
      'direct',
    );
  } finally {
    unmount();
    mocks.roomTiming.mockResolvedValue({ packetsSent: 0, packetsReceived: 0 });
  }
});

it('keeps the safe initial deadline until the physical route has a stable packet window', async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 12,
    requestedVoiceDelayMs: 12,
    packetsSent: 100,
    packetsReceived: 100,
    relayEchoes: 4,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
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

  await waitFor(() => expect(mocks.roomTiming).toHaveBeenCalled());
  expect(mocks.setVoiceLatency).not.toHaveBeenCalled();
  unmount();
});

it("waits for direct connectivity instead of accepting the backup relay's packet window", async () => {
  mocks.roomTiming.mockResolvedValue({
    estimatedVoiceLatencyMs: 12,
    requestedVoiceDelayMs: 12,
    packetsSent: 2000,
    packetsReceived: 2000,
    relayEchoes: 4,
    networkTransportRunning: true,
    networkSendEnabled: true,
    voiceRoute: 'checking',
    remotes: {},
  });
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
  await waitFor(() => expect(mocks.roomTiming).toHaveBeenCalled());
  expect(mocks.setVoiceLatency).not.toHaveBeenCalled();
  unmount();
});

it('publishes the measured p99 arrival requirement when recurring transport stalls exceed RTT/2', async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 147,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: 'ROOM42',
    roomPlayoutDelayMs: 60,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue(room);

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith(
      'ROOM42',
      147,
      undefined,
      true,
    ),
  );
  expect(mocks.setVoiceLatency).not.toHaveBeenCalledWith(
    'ROOM42',
    55,
    undefined,
    true,
  );
  unmount();
});

it('publishes the calibrated return and arrival stages with the route so the server can size its deadline', async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 20,
    requestedVoiceDelayMs: 31.24,
    returnRequirementMs: 4.26,
    arrivalRequirementMs: 12.04,
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
  mocks.setVoiceLatency.mockResolvedValue({
    ...room,
    roomPlayoutDelayMs: 32.5,
  });

  const { unmount } = renderHook(() =>
    useRoomVoicePolls('ROOM42', { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith(
      'ROOM42',
      31.2,
      {
        returnRequirementMs: 4.3,
        arrivalRequirementMs: 12,
      },
      true,
    ),
  );
  unmount();
});
