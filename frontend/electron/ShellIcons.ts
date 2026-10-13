import { nativeImage, type NativeImage } from "electron";

/** Coverage (0..1) of a shape at a point in a unit square, x and y from 0 to 1. */
type Shape = (x: number, y: number) => boolean;

const supersample = 4;

/**
 * Draws small monochrome icons for the taskbar (thumbnail buttons, overlay badges) without shipping
 * image files: each shape is sampled 4×4 times per pixel for smooth edges.
 */
export const drawIcon = (shape: Shape, color: readonly [number, number, number], size = 16): Buffer => {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1)
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < supersample; sy += 1)
        for (let sx = 0; sx < supersample; sx += 1)
          if (shape((px + (sx + 0.5) / supersample) / size, (py + (sy + 0.5) / supersample) / size)) hits += 1;
      const alpha = hits / (supersample * supersample);
      const offset = (py * size + px) * 4;
      // Windows bitmaps are BGRA with premultiplied alpha.
      pixels[offset] = Math.round(color[2] * alpha);
      pixels[offset + 1] = Math.round(color[1] * alpha);
      pixels[offset + 2] = Math.round(color[0] * alpha);
      pixels[offset + 3] = Math.round(255 * alpha);
    }
  return pixels;
};

const circle = (cx: number, cy: number, r: number): Shape => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const rect = (x0: number, y0: number, x1: number, y1: number): Shape => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
/** A triangle pointing right with its left edge at x0 and its tip at x1. */
const triangle = (x0: number, x1: number, top: number, bottom: number): Shape => (x, y) => {
  if (x < x0 || x > x1) return false;
  const half = ((bottom - top) / 2) * (1 - (x - x0) / (x1 - x0));
  const middle = (top + bottom) / 2;
  return y >= middle - half && y <= middle + half;
};
const ring = (cx: number, cy: number, r: number, width: number, from: number, to: number): Shape => (x, y) => {
  const distance = Math.hypot(x - cx, y - cy);
  const angle = Math.atan2(y - cy, x - cx);
  return Math.abs(distance - r) <= width / 2 && angle >= from && angle <= to;
};
const union = (...shapes: Shape[]): Shape => (x, y) => shapes.some((shape) => shape(x, y));

export const iconShapes = {
  play: triangle(0.28, 0.82, 0.18, 0.82),
  pause: union(rect(0.24, 0.18, 0.42, 0.82), rect(0.58, 0.18, 0.76, 0.82)),
  next: union(triangle(0.14, 0.52, 0.22, 0.78), triangle(0.48, 0.86, 0.22, 0.78)),
  // A dot with two arcs on each side: a broadcast.
  radio: union(
    circle(0.5, 0.5, 0.1),
    ring(0.5, 0.5, 0.26, 0.08, -0.7, 0.7),
    ring(0.5, 0.5, 0.42, 0.08, -0.7, 0.7),
    (x, y) => ring(0.5, 0.5, 0.26, 0.08, -0.7, 0.7)(1 - x, y),
    (x, y) => ring(0.5, 0.5, 0.42, 0.08, -0.7, 0.7)(1 - x, y),
  ),
  dot: circle(0.5, 0.5, 0.42),
  // Two heads and shoulders: people in a room.
  people: union(circle(0.34, 0.36, 0.14), circle(0.68, 0.4, 0.12), circle(0.34, 0.86, 0.3), circle(0.68, 0.86, 0.24)),
} as const;

const white = [255, 255, 255] as const;
const cache = new Map<string, NativeImage>();

export const shellIcon = (
  name: keyof typeof iconShapes,
  color: readonly [number, number, number] = white,
  size = 16,
): NativeImage => {
  const key = `${name}:${color.join(",")}:${size}`;
  let image = cache.get(key);
  if (!image) {
    image = nativeImage.createFromBitmap(drawIcon(iconShapes[name], color, size), { width: size, height: size });
    cache.set(key, image);
  }
  return image;
};

/** Badges on the taskbar icon: recording wins over being in a room. */
export const overlayColors = {
  recording: [235, 40, 60],
  room: [140, 90, 255],
} as const;
