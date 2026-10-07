/** Conservative voice-band threshold; higher values used to gate voiced zero crossings audibly. */
export const noiseThreshold = (amount: number): number => amount * 0.03;

/** Keeps some ambience instead of hard-gating it, which avoids metallic pumping. */
export const noiseReduction = (amount: number): number => 1 - amount * 0.75;
