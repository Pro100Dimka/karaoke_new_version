export function estimateOffsetMs(left, right, sampleRate, maximumOffset = Math.min(2400, Math.floor(sampleRate / 5))) {
  let best = { offsetSamples: 0, correlation: -Infinity };
  for (let offset = -maximumOffset; offset <= maximumOffset; offset += 1) {
    const leftStart = Math.max(0, offset);
    const rightStart = Math.max(0, -offset);
    const count = Math.min(left.length - leftStart, right.length - rightStart);
    if (count < 16) continue;
    let product = 0, leftEnergy = 0, rightEnergy = 0;
    for (let index = 0; index < count; index += 1) {
      const a = left[leftStart + index], b = right[rightStart + index];
      product += a * b; leftEnergy += a * a; rightEnergy += b * b;
    }
    const correlation = product / Math.sqrt(leftEnergy * rightEnergy || 1);
    if (correlation > best.correlation) best = { offsetSamples: offset, correlation };
  }
  return { ...best, offsetMs: -best.offsetSamples * 1000 / sampleRate };
}
