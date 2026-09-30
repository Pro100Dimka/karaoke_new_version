const pollMilliseconds = 100;
// The chirp train plus the slowest plausible round trip takes about 1.5 s; this leaves ample margin.
const pollAttempts = 80;
// Repetition checks stability; the native meter separately rejects clock faults and ambiguous paths.
const measurementRuns = 3;
const agreementMilliseconds = 2;

type Command = (name: string) => Promise<string>;

const measureOnce = async (command: Command): Promise<{ milliseconds: number; context: string }> => {
  await command("MeasureAcousticLatency");
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, pollMilliseconds));
    // "state=Done|ms=28.0|confidence=0.92"
    const result = Object.fromEntries(
      (await command("GetAcousticLatency")).trim().split("|").map((field) => field.split("=")),
    ) as Record<string, string | undefined>;
    if (result.state === "Failed") throw new Error(result.reason === "timing"
      ? "Audio timestamps changed or packets were lost; repeat the measurement"
      : "The microphone did not hear an unambiguous test signal; move it closer to the speaker");
    if (result.state === "Done") {
      const milliseconds = Number(result.ms);
      if (!result.context || !result.ms?.trim() || !Number.isFinite(milliseconds)
        || milliseconds < 0 || milliseconds > 500 || !(Number(result.confidence) >= 0.3))
        throw new Error("Invalid latency measurement");
      return { milliseconds, context: result.context };
    }
  }
  throw new Error("Latency measurement timed out");
};

/**
 * Runs AudioService's acoustic latency measurement (quiet chirps from the speaker, found again in the
 * microphone) several times and resolves with the hidden delay in milliseconds that the runs agree on.
 */
export const measureAcousticLatency = async (command: Command): Promise<{ milliseconds: number; context: string }> => {
  const values: number[] = [];
  let context = "";
  let failure: unknown = new Error("The microphone did not hear the test signal");
  for (let run = 0; run < measurementRuns; run += 1) {
    let found;
    try {
      found = await measureOnce(command);
    } catch (error) {
      failure = error;
      continue;
    }
    if (context && context !== found.context) throw new Error("Audio configuration changed during measurement");
    context = found.context;
    values.push(found.milliseconds);
  }
  const best = values
    .map((value) => values.filter((other) => Math.abs(other - value) <= agreementMilliseconds))
    .sort((left, right) => right.length - left.length)[0];
  if (!best || best.length < 2) {
    if (values.length < 2) throw failure;
    throw new Error("The runs disagree: echo cancellation or noise hid the test signal");
  }
  const sorted = [...best].sort((left, right) => left - right);
  return { milliseconds: sorted[Math.floor(sorted.length / 2)]!, context };
};
