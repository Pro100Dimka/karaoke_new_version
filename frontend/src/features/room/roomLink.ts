import type { RoomTimingReport } from "../../contracts/clients";

export type VoiceRoute = "direct" | "relay";

export interface RoomLinkState {
  /** How most voice packets reached this listener; undefined before any arrived. */
  route?: VoiceRoute;
  /** Voice arrived too late and was cut: the link stalls (typically Wi-Fi or a busy uplink). */
  unstable: boolean;
}

const total = (report: RoomTimingReport, field: "relayPackets" | "directPackets" | "lateCuts") =>
  Object.values(report.remotes).reduce((sum, remote) => sum + (remote[field] || 0), 0);

/** Route and stability of the room voices between an earlier timing report and the current one. */
export const roomLink = (
  earlier: RoomTimingReport | undefined,
  current: RoomTimingReport,
): RoomLinkState => {
  const since = (field: "relayPackets" | "directPackets" | "lateCuts") =>
    Math.max(0, total(current, field) - (earlier ? total(earlier, field) : 0));
  const relay = since("relayPackets");
  const direct = since("directPackets");
  return {
    route: relay + direct === 0 ? undefined : direct >= relay ? "direct" : "relay",
    unstable: earlier !== undefined && since("lateCuts") > 0,
  };
};
