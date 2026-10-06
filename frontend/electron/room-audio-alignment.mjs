export function estimateOffsetMs(
  left,
  right,
  sampleRate,
  maximumOffset = Math.min(2400, Math.floor(sampleRate / 5)),
) {
  const window = Math.min(
    left.length,
    right.length,
    Math.max(512, Math.floor(sampleRate * 0.25)),
  );
  const starts = [];
  for (
    let start = 0;
    start + window <= Math.min(left.length, right.length);
    start += window
  ) {
    let energy = 0;
    for (let index = 0; index < window; index += 16)
      energy += left[start + index] ** 2 + right[start + index] ** 2;
    starts.push({ start, energy });
  }
  const windows = starts.sort((a, b) => b.energy - a.energy).slice(0, 8);
  let best = { offsetSamples: 0, correlation: -Infinity };
  for (let offset = -maximumOffset; offset <= maximumOffset; offset += 1) {
    for (const { start } of windows) {
      const leftStart = start + Math.max(0, offset);
      const rightStart = start + Math.max(0, -offset);
      const count = Math.min(
        window,
        left.length - leftStart,
        right.length - rightStart,
      );
      if (count < 16) continue;
      let product = 0,
        leftEnergy = 0,
        rightEnergy = 0;
      for (let index = 0; index < count; index += 4) {
        const a = left[leftStart + index],
          b = right[rightStart + index];
        product += a * b;
        leftEnergy += a * a;
        rightEnergy += b * b;
      }
      const correlation = product / Math.sqrt(leftEnergy * rightEnergy || 1);
      if (correlation > best.correlation)
        best = { offsetSamples: offset, correlation };
    }
  }
  return { ...best, offsetMs: (-best.offsetSamples * 1000) / sampleRate };
}
