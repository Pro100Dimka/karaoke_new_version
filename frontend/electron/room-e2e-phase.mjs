export const classifyLateCutPhase = (
  frame,
  durationSeconds,
  sampleRate = 48_000,
  drainMs = 100,
) =>
  frame >= durationSeconds * sampleRate - (sampleRate * drainMs) / 1_000
    ? "DRAIN"
    : "ACTIVE";
