const pollMilliseconds = 100;
// The chirp train plus the slowest plausible round trip takes about 1.5 s; this leaves ample margin.
const pollAttempts = 80;
// A real device delay repeats to the millisecond. A false match (echo cancellation removing the
// chirps, room noise) lands somewhere else each time, so a result counts only when runs agree.
const measurementRuns = 3;
const agreementMilliseconds = 2;

type Command = (name: string) => Promise<string>;

const measureOnce = async (command: Command): Promise<number> => {
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

/**
 * Runs AudioService's acoustic latency measurement (quiet chirps from the speaker, found again in the
 * microphone) several times and resolves with the hidden delay in milliseconds that the runs agree on.
 */
export const measureAcousticLatency = async (command: Command): Promise<number> => {
  const values: number[] = [];
  let failure: unknown = new Error("The microphone did not hear the test signal");
  for (let run = 0; run < measurementRuns; run += 1) {
    try {
      values.push(await measureOnce(command));
    } catch (error) {
      failure = error;
    }
  }
  const best = values
    .map((value) => values.filter((other) => Math.abs(other - value) <= agreementMilliseconds))
    .sort((left, right) => right.length - left.length)[0];
  if (!best || best.length < 2) {
    if (values.length < 2) throw failure;
    throw new Error("The runs disagree: echo cancellation or noise hid the test signal");
  }
  const sorted = [...best].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};
