export const classifyRoomE2eFailure = ({
  audioAlignment,
  relayMetrics,
  routes,
  processReports,
  lateCutPhases = [],
}) => {
  const activeLateCut = lateCutPhases.some(
    (item) => item.lateAudioCuts > 0 && item.firstPhase !== "DRAIN",
  );
  const drainOnlyLateCut =
    processReports.some((item) => item.lateAudioCuts > 0) &&
    lateCutPhases.length > 0 &&
    lateCutPhases.every(
      (item) => item.lateAudioCuts === 0 || item.firstPhase === "DRAIN",
    );
  if (routes.deadlineMarginMs < 0 || activeLateCut)
    return "NETWORK_DEADLINE_MISS";
  const lifecycle = relayMetrics.pending_lifecycle;
  const lifecyclePositions =
    lifecycle?.created_positions ?? relayMetrics.positions ?? 0;
  if (
    lifecyclePositions > 0 &&
    (lifecycle?.complete_nonempty_positions ?? 0) < lifecyclePositions * 0.95
  )
    return "SERVER_MIX_INCOMPLETE";
  if (drainOnlyLateCut) return "DRAIN_LIFECYCLE";
  if (
    (relayMetrics.max_expected_mixers ?? 0) > 1 &&
    (relayMetrics.max_inputs_seen ?? 0) <
      (relayMetrics.max_expected_mixers ?? 0) &&
    (relayMetrics.ingress_nonzero_packets ?? 0) > 0
  )
    return "MUSICAL_POSITION_MISMATCH";
  if ((relayMetrics.nonzero_recipient_packets ?? 0) === 0)
    return "SERVER_MIX_EMPTY";
  if (audioAlignment.remoteVocalSkewMs === null) return "PILOT_NOT_DETECTED";
  if (
    Math.abs(audioAlignment.backingSkewMs ?? Infinity) > 10 ||
    Math.abs(audioAlignment.remoteVocalSkewMs) > 10
  )
    return "ALIGNMENT_EXCEEDED";
  if (
    processReports.some(
      (item) => item.packetsReceived < item.packetsSent * 0.95,
    )
  )
    return "DELIVERY_FAILURE";
  return null;
};
