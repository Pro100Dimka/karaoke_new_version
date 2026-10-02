export function measuredVoiceLatencyMs({ upstreamP95Ms, downstreamP95Ms }) {
  return Math.max(0, upstreamP95Ms) + Math.max(0, downstreamP95Ms);
}
