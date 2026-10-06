import { useEffect, useRef } from "react";

const clamp = (value: number, minimum: number, maximum: number) =>
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
    x = x * 2.07 + 13.2;
    y = y * 2.07 - 7.4;
    amplitude *= 0.5;
  }
  return value;
};

/** Ruby veins drifting behind the settings window; painted once, turned to the theme hue by CSS. */
export const SettingsAtmosphere = () => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (navigator.userAgent.includes("jsdom")) return;
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const low = document.createElement("canvas");
    low.width = 671;
    low.height = 532;
    const lowContext = low.getContext("2d");
    if (!lowContext) return;
    const image = lowContext.createImageData(low.width, low.height);
    for (let py = 0; py < low.height; py += 1)
      for (let px = 0; px < low.width; px += 1) {
        const x = px * 2 + 31,
          y = py * 2 + 24;
        const warp = (fbm(x * 0.003, y * 0.003) - 0.48) * 125;
        const n = fbm(x * 0.012 + warp * 0.014, y * 0.012 - warp * 0.012);
        const vein =
          1 - Math.abs(2 * fbm(x * 0.017 + 2 * n, y * 0.017 + 3 * n) - 1);
        const band = Math.exp(
          -(
            ((y - (x * 0.5 - 198 + 44 * Math.sin(x * 0.013)) + warp) / 83) **
            2
          ),
        );
        const perimeter =
          Math.exp(-(((x + warp) / 65) ** 2)) +
          Math.exp(-(((1404 - x + warp) / 60) ** 2)) +
          0.7 * Math.exp(-(((1120 - y + warp) / 56) ** 2));
        const mask = Math.min(1.25, band * 1.2 + perimeter);
        const thread = Math.pow(clamp((vein - 0.62) * 3, 0, 1), 3.6);
        const detail = fbm(x * 0.032 + warp * 0.06, y * 0.032, 4);
        const hot = Math.pow(clamp((detail - 0.37) * 3, 0, 1), 2.5) * thread;
        const luminance =
          mask *
          (5 +
            135 * Math.pow(n, 2.5) +
            155 * thread * Math.pow(n, 1.5) +
            220 * hot);
        const pixel = (py * low.width + px) * 4;
        image.data[pixel] = 5 + luminance;
        image.data[pixel + 1] = 3 + luminance * 0.13;
        image.data[pixel + 2] = 7 + luminance * 0.28;
        image.data[pixel + 3] = 255;
      }
    lowContext.putImageData(image, 0, 0);
    context.drawImage(low, 0, 0, canvas.width, canvas.height);
    const shade = context.createLinearGradient(0, 0, 0, canvas.height);
    shade.addColorStop(0, "rgba(0,0,3,.10)");
    shade.addColorStop(0.12, "rgba(0,0,3,.55)");
    shade.addColorStop(1, "rgba(0,0,3,.70)");
    context.fillStyle = shade;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, []);
  return (
    <canvas
      ref={ref}
      className="settingsAtmosphere"
      width="1342"
      height="1063"
      aria-hidden="true"
    />
  );
};
