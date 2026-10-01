import { useEffect, useRef } from "react";

type Point = readonly [number, number];

const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, value));
const random = (initialSeed: number) => {
  let seed = initialSeed;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};
const noiseTable = Float32Array.from({ length: 65536 }, random(7149));
const noise = (x: number, y: number) => {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  let fx = x - ix,
    fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const point = (a: number, b: number) =>
    noiseTable[(a & 255) + ((b & 255) << 8)] ?? 0;
  const a = point(ix, iy),
    b = point(ix + 1, iy),
    c = point(ix, iy + 1),
    d = point(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
};
const fbm = (initialX: number, initialY: number, count = 5) => {
  let x = initialX,
    y = initialY,
    value = 0,
    amplitude = 0.5;
  for (let index = 0; index < count; index += 1) {
    value += noise(x, y) * amplitude;
    x = x * 2.03 + 13.2;
    y = y * 2.07 - 7.4;
    amplitude *= 0.5;
  }
  return value;
};
const glow = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha: number,
) => {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(${color},${alpha})`);
  gradient.addColorStop(1, `rgba(${color},0)`);
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
};
const polygon = (
  context: CanvasRenderingContext2D,
  points: readonly Point[],
  fill: string,
  stroke?: string,
  width = 0.6,
) => {
  context.beginPath();
  points.forEach(([x, y], index) =>
    index ? context.lineTo(x, y) : context.moveTo(x, y),
  );
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  if (!stroke) return;
  context.strokeStyle = stroke;
  context.lineWidth = width;
  context.stroke();
};

export const ProfileLandscape = () => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || navigator.userAgent.includes("jsdom")) return;
    const context = canvas?.getContext("2d");
    if (!context) return;
    const paintLandscape = () => {
      const width = canvas.width,
        height = canvas.height,
        scale = width / 1220;
      const image = context.createImageData(width, height),
        centerX = 1129,
        centerY = 309,
        radius = 346;
      for (let py = 0; py < height; py += 1)
        for (let px = 0; px < width; px += 1) {
          const x = px / scale,
            y = py / scale;
          const n = fbm(x * 0.012, y * 0.013 + 20),
            warp = fbm(x * 0.004, y * 0.005) * 70;
          const f = fbm(x * 0.025 + warp * 0.03, y * 0.032 + warp * 0.02);
          const ridge =
            1 - Math.abs(2 * fbm(x * 0.026 + n * 5, y * 0.034 + n * 5, 5) - 1);
          const threads =
            Math.pow(clamp((ridge - 0.61) * 2.7), 4) *
            Math.pow(clamp((f - 0.33) * 3), 1.3);
          const horizon = Math.exp(
            -(((x - 820) / 160) ** 2 + ((y - 171) / 40) ** 2),
          );
          const cloud =
            Math.exp(-(((x - 830) / 340) ** 2)) *
            (8 + 32 * n ** 2 + 95 * threads);
          let red = 6 + cloud + horizon * 170,
            green = 8 + cloud * 0.19 + horizon * 32,
            blue = 14 + cloud * 0.3 + horizon * 44;
          const dx = (x - centerX) / radius,
            dy = (y - centerY) / radius,
            radial = Math.hypot(dx, dy),
            edge = (1 - radial) * radius;
          const sideLight = clamp(0.18 - dx * 0.98 - dy * 0.15, 0.08, 1.3);
          if (radial <= 1) {
            const z = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
            const terrain = fbm(dx * 22 + z * 9, dy * 26 + z * 4, 6);
            const geology = fbm(
              dx * 78 + terrain * 9,
              dy * 82 + terrain * 7,
              3,
            );
            const vein =
              1 -
              Math.abs(
                fbm(dx * 83 + geology * 5, dy * 97 + geology * 5, 3) * 2 - 1,
              );
            const lava =
              Math.pow(clamp((vein - 0.66) * 2.9), 5) *
              Math.pow(clamp((terrain - 0.34) * 3.3), 1.6);
            const rim = Math.exp(-Math.max(0, edge) / 2.15) * sideLight;
            const atmosphere = Math.exp(-Math.max(0, edge) / 23) * sideLight;
            const face = clamp(0.5 - dx * 0.32 - z * 0.5, 0.12, 0.6);
            red =
              7 +
              face * (26 + 46 * terrain) +
              lava * 82 +
              rim * 238 +
              atmosphere * 166;
            green =
              8 +
              face * (17 + 12 * terrain) +
              lava * 5 +
              rim * 202 +
              atmosphere * 38;
            blue =
              16 +
              face * (21 + 18 * terrain) +
              lava * 14 +
              rim * 211 +
              atmosphere * 62;
          } else if (radial < 1.12) {
            const halo = Math.exp(edge / 13) * sideLight;
            red += halo * 142;
            green += halo * 18;
            blue += halo * 34;
          }
          const pixel = (py * width + px) * 4;
          image.data[pixel] = red;
          image.data[pixel + 1] = green;
          image.data[pixel + 2] = blue;
          image.data[pixel + 3] = 255;
        }
      context.putImageData(image, 0, 0);
      context.save();
      context.scale(scale, scale);
      const next = random(840);
      for (let index = 0; index < 350; index += 1) {
        const x = 410 + next() * 810,
          y = next() * 168;
        if (Math.hypot(x - centerX, y - centerY) < radius) continue;
        context.fillStyle = `rgba(255,${55 + Math.round(next() * 68)},${75 + Math.round(next() * 70)},${0.1 + next() * 0.4})`;
        context.beginPath();
        context.arc(x, y, 0.15 + next() * 0.57, 0, Math.PI * 2);
        context.fill();
      }
      glow(context, 828, 156, 96, "255,98,96", 0.26);
      glow(context, 828, 156, 38, "255,168,132", 0.4);
      const mountain = (
        points: readonly Point[],
        base: number,
        color: string,
        line: string,
        seed: number,
      ) => {
        const rand = random(seed),
          fine: Point[] = [];
        for (let index = 0; index < points.length - 1; index += 1) {
          const [x1, y1] = points[index]!,
            [x2, y2] = points[index + 1]!;
          fine.push([x1, y1]);
          for (let division = 1; division <= 3; division += 1) {
            const amount = division / 4;
            fine.push([
              x1 + (x2 - x1) * amount,
              y1 + (y2 - y1) * amount + (rand() - 0.5) * 6,
            ]);
          }
        }
        fine.push(points[points.length - 1]!);
        polygon(context, [...fine, [1220, base], [0, base]], color);
        context.beginPath();
        fine.forEach(([x, y], index) =>
          index ? context.lineTo(x, y) : context.moveTo(x, y),
        );
        context.strokeStyle = line;
        context.lineWidth = 0.8;
        context.stroke();
        for (let index = 1; index < fine.length - 1; index += 1) {
          const [x, y] = fine[index]!;
          if (fine[index - 1]![1] < y || fine[index + 1]![1] < y) continue;
          const foot: Point = [
            x + 8 + rand() * 27,
            Math.min(base + 8, y + 20 + rand() * 32),
          ];
          polygon(
            context,
            [fine[index - 1]!, [x, y], foot],
            `rgba(52,33,45,${0.12 + rand() * 0.26})`,
          );
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(x + 5 + rand() * 8, y + 12 + rand() * 8);
          context.lineTo(...foot);
          context.strokeStyle = `rgba(192,49,69,${0.1 + rand() * 0.26})`;
          context.lineWidth = 0.6;
          context.stroke();
        }
      };
      mountain(
        [
          [0, 168],
          [410, 166],
          [475, 155],
          [518, 149],
          [548, 151],
          [582, 138],
          [610, 135],
          [650, 148],
          [697, 144],
          [725, 135],
          [749, 146],
          [768, 143],
          [788, 152],
          [825, 143],
          [843, 150],
          [868, 145],
          [891, 147],
          [918, 141],
          [945, 148],
          [989, 153],
          [1025, 149],
          [1100, 155],
          [1175, 144],
          [1220, 163],
        ],
        180,
        "#451320",
        "#ef56667a",
        716,
      );
      mountain(
        [
          [0, 169],
          [440, 168],
          [475, 153],
          [497, 151],
          [516, 138],
          [534, 123],
          [546, 128],
          [561, 114],
          [574, 112],
          [585, 100],
          [597, 94],
          [608, 96],
          [622, 113],
          [633, 113],
          [650, 132],
          [663, 121],
          [678, 117],
          [690, 129],
          [701, 141],
          [722, 145],
          [739, 155],
          [779, 158],
          [803, 148],
          [821, 153],
          [844, 149],
          [863, 145],
          [874, 135],
          [887, 129],
          [899, 128],
          [913, 140],
          [927, 145],
          [939, 144],
          [956, 151],
          [976, 154],
          [995, 164],
          [1110, 168],
          [1180, 152],
          [1202, 130],
          [1220, 132],
        ],
        181,
        "#080a10",
        "#7f2635a0",
        282,
      );
      context.restore();
    };
    paintLandscape();
  }, []);
  return (
    <canvas
      ref={ref}
      className="profileLandscape"
      width="2440"
      height="336"
      aria-hidden="true"
    />
  );
};
