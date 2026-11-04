import type { RoomTimingReport } from '../../contracts/clients';

type VoiceRoute = 'direct' | 'relay';

export interface RoomLinkState {
  /** How most voice packets reached this listener; undefined before any arrived. */
  route?: VoiceRoute;
  /** Recent voice delivery or playout gaps, or an unavailable transport. */
  unstable: boolean;
  /** Confirmed output underruns or a device timeline discontinuity. */
  deviceStarving: boolean;
}

/** Route and stability of the room voices between an earlier timing report and the current one. */
export const roomLink = (
  earlier: RoomTimingReport | undefined,
  current: RoomTimingReport,
): RoomLinkState => {
  if (earlier?.generationId !== current.generationId) earlier = undefined;
  const since = (
    field:
      | 'relayPackets'
      | 'directPackets'
      | 'lateCuts'
      | 'decodeUnderruns'
      | 'lostPackets',
  ) =>
    Object.entries(current.remotes).reduce((sum, [id, remote]) => {
      const value = remote[field] ?? 0;
      return (
        sum +
        Math.max(
          0,
          value - (earlier?.remotes[id]?.[field] ?? (earlier ? value : 0)),
        )
      );
    }, 0);
  const relay = since('relayPackets');
  const direct = since('directPackets');
  return {
    route:
      relay + direct === 0 ? undefined : direct >= relay ? 'direct' : 'relay',
    unstable:
      !current.networkTransportRunning ||
      Object.values(current.remotes).some((remote) => remote.excluded) ||
      (earlier !== undefined &&
        (since('lateCuts') > 0 ||
          since('decodeUnderruns') > 0 ||
          since('lostPackets') > 0 ||
          (Object.keys(current.remotes).length > 0 && relay + direct === 0))),
    deviceStarving:
      earlier !== undefined &&
      current.deviceStarvedFrames > earlier.deviceStarvedFrames,
  };
};
