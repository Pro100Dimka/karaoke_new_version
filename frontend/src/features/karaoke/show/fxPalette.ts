/**
 * The show's colours: pink/magenta is the singer's energy, cyan/teal the music and the space, violet the moment
 * both meet. White and gold only for the brightest cores and fireworks.
 */
export const fxColors = {
  magenta: [255, 46, 138],
  pink: [255, 110, 190],
  red: [255, 52, 84],
  cyan: [46, 226, 255],
  teal: [30, 200, 190],
  violet: [160, 92, 255],
  white: [255, 245, 250],
  gold: [255, 206, 120],
} as const satisfies Record<string, readonly [number, number, number]>;

export type FxColor = keyof typeof fxColors;

/** The colour as 0–1 light for the GPU. */
export const light = (color: FxColor): readonly [number, number, number] => {
  const [r, g, b] = fxColors[color];
  return [r / 255, g / 255, b / 255];
};
export const fxColorNames = Object.keys(fxColors) as FxColor[];

export const rgba = (color: FxColor, alpha: number): string => {
  const [r, g, b] = fxColors[color];
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const smoothstep = (
  edge0: number,
  edge1: number,
  value: number,
): number => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
export const approach = (
  current: number,
  target: number,
  elapsed: number,
  seconds: number,
): number => current + (target - current) * (1 - Math.exp(-elapsed / seconds));
