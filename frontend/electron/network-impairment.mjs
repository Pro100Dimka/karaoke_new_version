export const latencyAt = (stages, elapsedMs) =>
  stages.find(stage => elapsedMs < stage.untilMs)?.latencyMs ?? stages.at(-1)?.latencyMs ?? 0;

const fixedRandom = seed => {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

export const createImpairmentSequence = (profile, seed, count) => {
  const random = fixedRandom(seed);
  return Array.from({ length: count }, () => {
    const dropped = random() < profile.loss;
    const jitteredDelay = profile.latencyMs + (random() * 2 - 1) * profile.jitterMs;
    const duplicate = random() < profile.duplicate;
    const reordered = random() < (profile.reorder ?? 0);
    return {
      dropped,
      delayMs: Math.max(0, Math.round(jitteredDelay + (reordered ? (profile.reorderDelayMs ?? 10) : 0))),
      duplicate,
      reordered
    };
  });
};

export const createImpairment = (profile, seed) => {
  const random = fixedRandom(seed);
  let packetIndex = 0;
  let nextTransmitAtMs = 0;
  return (elapsedMs, packetBytes = 0) => {
    const inOutage = (profile.outages ?? []).some(
      outage => elapsedMs >= outage.fromMs && elapsedMs < outage.untilMs);
    const burst = profile.burstLoss;
    const inBurst = burst && burst.everyPackets > 0 &&
      packetIndex % burst.everyPackets < burst.lengthPackets;
    let dropped = inOutage || Boolean(inBurst) || random() < (profile.loss ?? 0);
    const jitteredDelay = latencyAt(profile.stages, elapsedMs) +
      (random() * 2 - 1) * (profile.jitterMs ?? 0);
    const duplicate = random() < (profile.duplicate ?? 0);
    const reordered = random() < (profile.reorder ?? 0);
    const stallDelayMs = (profile.stalls ?? [])
      .filter(stall => elapsedMs >= stall.fromMs && elapsedMs < stall.untilMs)
      .reduce((maximum, stall) => Math.max(maximum, stall.delayMs), 0);
    let queueDelayMs = 0;
    let queueOverflow = false;
    if ((profile.bandwidthKbps ?? 0) > 0 && packetBytes > 0) {
      const serializationMs = packetBytes * 8 / profile.bandwidthKbps;
      queueDelayMs = Math.max(0, nextTransmitAtMs - elapsedMs);
      queueOverflow = queueDelayMs > (profile.queueLimitMs ?? Number.POSITIVE_INFINITY);
      if (queueOverflow) {
        dropped = true;
        queueDelayMs = profile.queueLimitMs;
      } else {
        nextTransmitAtMs = Math.max(elapsedMs, nextTransmitAtMs) + serializationMs;
      }
    }
    const corrupted = random() < (profile.corrupt ?? 0);
    const stale = random() < (profile.stale ?? 0);
    const wrongToken = random() < (profile.wrongToken ?? 0);
    const clockSkewMs = elapsedMs * (profile.driftPpm ?? 0) / 1_000_000;
    packetIndex += 1;
    return {
      dropped,
      delayMs: Math.max(0, Math.round(jitteredDelay + stallDelayMs + queueDelayMs +
        (reordered ? (profile.reorderDelayMs ?? 10) : 0))),
      duplicate,
      reordered,
      clockSkewMs,
      queueDelayMs,
      queueOverflow,
      corrupted,
      stale,
      wrongToken
    };
  };
};
