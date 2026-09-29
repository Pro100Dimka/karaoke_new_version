const pollMilliseconds = 100;
// The chirp train plus the slowest plausible round trip takes about 1.5 s; this leaves ample margin.
const pollAttempts = 80;

/**
 * Runs AudioService's acoustic latency measurement (quiet chirps from the speaker, found again in the
 * microphone) and resolves with the hidden delay in milliseconds.
 */
export const measureAcousticLatency = async (command: (name: string) => Promise<string>): Promise<number> => {
  await command("MeasureAcousticLatency");
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, pollMilliseconds));
    // "state=Done|ms=28.0|confidence=0.92"
    const result = Object.fromEntries(
      (await command("GetAcousticLatency")).trim().split("|").map((field) => field.split("=")),
    ) as Record<string, string | undefined>;
    if (result.state === "Failed") throw new Error("The microphone did not hear the test signal");
    if (result.state === "Done") return Number(result.ms) || 0;
  }
  throw new Error("Latency measurement timed out");
};
