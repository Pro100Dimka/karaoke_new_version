import { describe, expect, it } from 'vitest';
import type { RoomTimingReport } from '../../contracts/clients';
import { roomLink } from './roomLink';

const report = (
  relayPackets: number,
  directPackets: number,
  lateCuts = 0,
  deviceStarvedFrames = 0,
) =>
  ({
    roundTripMs: 40,
    deviceLatencyMs: 10,
    estimatedVoiceLatencyMs: 30,
    voiceDelayMs: 12,
    followMs: 0,
    packetsSent: 0,
    packetsReceived: 0,
    relayEchoes: 0,
    networkTransportRunning: true,
    networkSendEnabled: true,
    deviceStarvedFrames,
    remotes: {
      friend: {
        jitterMs: 1,
        targetDelayMs: 12,
        relayPackets,
        directPackets,
        lateCuts,
      },
    },
  }) satisfies RoomTimingReport;

describe('roomLink', () => {
  it('names the route that delivered most voice since the earlier report', () => {
    expect(roomLink(report(100, 0), report(110, 4000)).route).toBe('direct');
    expect(roomLink(report(0, 100), report(4000, 110)).route).toBe('relay');
    expect(roomLink(undefined, report(0, 0)).route).toBeUndefined();
  });

  it('flags recent cuts even below the timing policy loss allowance', () => {
    expect(roomLink(report(0, 100, 3), report(0, 900, 3)).unstable).toBe(false);
    expect(roomLink(report(0, 100, 3), report(0, 900, 5)).unstable).toBe(true);
    // 12 cuts in 800 packets (15 per thousand) are a stalling link.
    expect(roomLink(report(0, 100, 3), report(0, 900, 15)).unstable).toBe(true);
    expect(roomLink(undefined, report(0, 900, 15)).unstable).toBe(false);
  });

  it.each(['decodeUnderruns', 'lostPackets'])(
    'flags recent %s even while packets arrive',
    (field) => {
      const before = report(100, 0);
      const after = report(900, 0);
      expect(
        roomLink(
          {
            ...before,
            remotes: {
              friend: { ...before.remotes.friend, [field]: 29 },
            },
          },
          {
            ...after,
            remotes: { friend: { ...after.remotes.friend, [field]: 30 } },
          },
        ).unstable,
      ).toBe(true);
    },
  );

  it('flags stopped reception and a stopped transport', () => {
    expect(roomLink(report(100, 0), report(100, 0)).unstable).toBe(true);
    expect(
      roomLink(undefined, { ...report(0, 0), networkTransportRunning: false })
        .unstable,
    ).toBe(true);
  });

  it('does not let a departing peer hide another peer losing audio', () => {
    const before = report(100, 0, 2);
    const after = report(200, 0, 3);
    expect(
      roomLink(
        {
          ...before,
          remotes: {
            ...before.remotes,
            leaving: { ...before.remotes.friend, lateCuts: 100 },
          },
        },
        after,
      ).unstable,
    ).toBe(true);
  });

  it('does not compare counters across device generations', () => {
    expect(
      roomLink(
        { ...report(100, 0, 0, 0), generationId: 1 },
        { ...report(200, 0, 5, 480), generationId: 2 },
      ),
    ).toMatchObject({ unstable: false, deviceStarving: false });
  });

  it('flags a sound card that starves on this computer', () => {
    expect(
      roomLink(report(0, 100, 0, 480), report(0, 900, 0, 480)).deviceStarving,
    ).toBe(false);
    expect(
      roomLink(report(0, 100, 0, 480), report(0, 900, 0, 9_600)).deviceStarving,
    ).toBe(true);
  });
});
