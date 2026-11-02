/** The shapes of light a sprite can take on the canvas. */
export const spriteKind = { glow: 0, ring: 1, flare: 2, bokeh: 3 } as const;
export type SpriteKind = (typeof spriteKind)[keyof typeof spriteKind];

export type Rgb = readonly [number, number, number];

// x, y, size, kind, r, g, b, intensity, param1, param2
export const spriteFloats = 10;
/**
 * One frame of sprites (glows, rings, flares, bokeh), written by the stage and drawn in a single pass.
 * A fixed buffer, reset every frame, avoids allocation while the show runs.
 */
export class LightBatch {
  readonly sprites: Float32Array;
  spriteCount = 0;

  constructor(readonly spriteCapacity: number) {
    this.sprites = new Float32Array(spriteCapacity * spriteFloats);
  }

  clear(): void {
    this.spriteCount = 0;
  }

  /**
   * A sprite: `size` is its radius in CSS pixels, `color` 0–1 linear light, `intensity` may exceed 1 (it blooms).
   * Rings take their radius (0–1 of size) and thickness in `a`/`b`; flares take their streak strength in `a`.
   */
  sprite(
    x: number,
    y: number,
    size: number,
    kind: SpriteKind,
    color: Rgb,
    intensity: number,
    a = 0,
    b = 0,
  ): void {
    if (
      this.spriteCount >= this.spriteCapacity ||
      intensity <= 0.002 ||
      size <= 0
    )
      return;
    const at = this.spriteCount++ * spriteFloats;
    const s = this.sprites;
    s[at] = x;
    s[at + 1] = y;
    s[at + 2] = size;
    s[at + 3] = kind;
    s[at + 4] = color[0];
    s[at + 5] = color[1];
    s[at + 6] = color[2];
    s[at + 7] = intensity;
    s[at + 8] = a;
    s[at + 9] = b;
  }
}
