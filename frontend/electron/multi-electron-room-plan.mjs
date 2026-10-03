export const phaseAtSecond = second => {
  if (second === 30) return "RECONNECT_B";
  if (second < 10 || (second >= 35 && second < 45)) return "A_TO_B";
  if ((second >= 10 && second < 20) || (second >= 45 && second < 55)) return "B_TO_A";
  if ((second >= 20 && second < 30) || second >= 55) return "BOTH";
  return "RECOVERY";
};

export const validateNegotiation = ({ publishedA, publishedB, selected, appliedA, appliedB }) => {
  if (publishedA >= 80 && publishedB >= 80 && selected <= 10)
    throw new Error(`Unsafe production deadline fallback selected ${selected} ms`);
  if (![selected, appliedA, appliedB].every(Number.isFinite) ||
      Math.abs(appliedA - selected) > 1 || Math.abs(appliedB - selected) > 1)
    throw new Error(`Room deadline was not applied consistently: ${selected}/${appliedA}/${appliedB}`);
};

export const toneState = phase => ({
  A_TO_B: [0.1, 0], B_TO_A: [0, 0.1], BOTH: [0.1, 0.1],
  RECONNECT_B: [0, 0], RECOVERY: [0, 0],
}[phase]);

export const roomE2eLiveDelay = args => {
  const option = args.find(value => value.startsWith("--live-delay="));
  if (!option) return 80;
  const value = Number(option.slice("--live-delay=".length));
  if (!Number.isFinite(value) || value < 10 || value > 80)
    throw new Error(`Live delay must be between 10 and 80 ms, received ${option}`);
  return value;
};

const activeSingingPhases = new Set(["A_TO_B", "B_TO_A", "BOTH"]);

export const maximumActiveLateCutDelta = (samples, valueOf) => {
  let previous, maximum = 0;
  for (const sample of samples) {
    if (!activeSingingPhases.has(sample.phase)) {
      previous = undefined;
      continue;
    }
    const current = valueOf(sample);
    if (previous !== undefined) maximum = Math.max(maximum, current - previous);
    previous = current;
  }
  return maximum;
};

export const toneContinuity = (samples, rate, frequency, fromSecond, toSecond) => {
  const first = Math.max(0, Math.floor(fromSecond * rate));
  const last = Math.min(samples.length, Math.floor(toSecond * rate));
  const windowFrames = Math.max(1, Math.round(rate * 0.02));
  let present = 0, windows = 0;
  for (let start = first; start + windowFrames <= last; start += windowFrames) {
    let sin = 0, cos = 0, total = 0;
    for (let index = start; index < start + windowFrames; index++) {
      const value = samples[index], phase = 2 * Math.PI * frequency * index / rate;
      sin += value * Math.sin(phase);
      cos += value * Math.cos(phase);
      total += value * value;
    }
    const tone = 2 * (sin * sin + cos * cos) / windowFrames;
    if (tone / Math.max(1e-12, total) >= 0.08) present++;
    windows++;
  }
  return windows === 0 ? 0 : present / windows;
};
