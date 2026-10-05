/** The shapes of light a sprite can take on the GPU. */
export const spriteKind = { glow: 0, ring: 1, flare: 2, bokeh: 3 } as const;
export type SpriteKind = (typeof spriteKind)[keyof typeof spriteKind];

export type Rgb = readonly [number, number, number];

// x, y, size, kind, r, g, b, intensity, param1, param2
export const spriteFloats = 10;
// x, y, along, across, r, g, b, intensity
export const beamVertexFloats = 8;

/**
 * One frame of light, written by the stage and drawn in a single pass: sprites (glows, rings, flares, bokeh) and
 * volumetric beams. Fixed buffers, reset every frame, no allocation while the show runs.
 */
export class LightBatch {
  readonly sprites: Float32Array;
  readonly beams: Float32Array;
  spriteCount = 0;
  beamCount = 0;

  constructor(readonly spriteCapacity: number, readonly beamCapacity: number) {
    this.sprites = new Float32Array(spriteCapacity * spriteFloats);
    this.beams = new Float32Array(beamCapacity * 3 * beamVertexFloats);
  }

  clear(): void {
    this.spriteCount = 0;
    this.beamCount = 0;
  }

  /**
   * A sprite: `size` is its radius in CSS pixels, `color` 0–1 linear light, `intensity` may exceed 1 (it blooms).
   * Rings take their radius (0–1 of size) and thickness in `a`/`b`; flares take their streak strength in `a`.
   */
  sprite(x: number, y: number, size: number, kind: SpriteKind, color: Rgb, intensity: number, a = 0, b = 0): void {
    if (this.spriteCount >= this.spriteCapacity || intensity <= 0.002 || size <= 0) return;
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

  /** A cone of light from (x, y) along `angle` (radians, 0 = up, clockwise) with half-width `spread` (radians). */
  beam(x: number, y: number, angle: number, spread: number, length: number, color: Rgb, intensity: number): void {
    if (this.beamCount >= this.beamCapacity || intensity <= 0.002) return;
    const at = this.beamCount++ * 3 * beamVertexFloats;
    const tip = (offset: number) => [x + Math.sin(angle + offset) * length, y - Math.cos(angle + offset) * length] as const;
    const [lx, ly] = tip(-spread);
    const [rx, ry] = tip(spread);
    this.vertex(at, x, y, 0, 0, color, intensity);
    this.vertex(at + beamVertexFloats, lx, ly, 1, -1, color, intensity);
    this.vertex(at + 2 * beamVertexFloats, rx, ry, 1, 1, color, intensity);
  }

  private vertex(at: number, x: number, y: number, along: number, across: number, color: Rgb, intensity: number): void {
    const b = this.beams;
    b[at] = x;
    b[at + 1] = y;
    b[at + 2] = along;
    b[at + 3] = across;
    b[at + 4] = color[0];
    b[at + 5] = color[1];
    b[at + 6] = color[2];
    b[at + 7] = intensity;
  }
}
