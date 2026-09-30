import { useEffect, useId, useMemo, useRef, type CSSProperties } from "react";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const random = (initialSeed: number) => {
  let seed = initialSeed;
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
};
const noiseTable = Float32Array.from({ length: 65536 }, random(7149));
const noise = (x: number, y: number) => {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const point = (a: number, b: number) => noiseTable[(a & 255) + ((b & 255) << 8)] ?? 0;
  const a = point(ix, iy), b = point(ix + 1, iy), c = point(ix, iy + 1), d = point(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
};
const fbm = (initialX: number, initialY: number, count = 5) => {
  let x = initialX, y = initialY, value = 0, amplitude = .5;
  for (let index = 0; index < count; index += 1) {
    value += noise(x, y) * amplitude;
    x = x * 2.07 + 13.2;
    y = y * 2.07 - 7.4;
    amplitude *= .5;
  }
  return value;
};

export const SettingsWaves = ({ kind }: { kind: "history" | "about" }) => {
  const ref = useRef<SVGSVGElement | null>(null);
  const quiet = kind === "about";
  const width = quiet ? 490 : 402;
  const height = quiet ? 98 : 187;
  const count = quiet ? 19 : 36;
  const gradientId = `settings-wave-gradient-${useId().replaceAll(":", "")}`;
  const stars = useMemo(() => {
    if (quiet) return [];
    const next = random(175);
    return Array.from({ length: 65 }, () => ({ x: next() * width, y: next() * height, radius: .25 + next() * .48, opacity: next() * .6 }));
  }, [height, quiet, width]);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const paths = [...svg.querySelectorAll<SVGPathElement>(".settingsWave")];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = performance.now();
    let lastPaint = -Infinity;
    const paint = (time: number) => {
      paths.forEach((path, index) => {
        const progress = index / (paths.length - 1);
        if (!quiet) {
          const phase = time * .7;
          const a = 18 * Math.sin(phase + index * .055);
          const b = 15 * Math.sin(phase + 1.5 + index * .05) - 15 * Math.sin(1.5 + index * .05) + 4 * Math.sin(index * .62);
          path.setAttribute("d", index < 21
            ? `M-18 ${35 + progress * 146 + a * .35} C36 ${-22 + progress * 156 + a} 76 ${-7 + progress * 155 + a} 136 ${67 + progress * 92 + b} C201 ${165 - progress * 35 + b} 262 ${146 - progress * 33 - a * .6} 312 ${106 + progress * 35 - a * .5} C352 ${65 + progress * 101 + a * .5} 385 ${74 + progress * 100 + a * .5} 418 ${133 + progress * 43 + b}`
            : `M-18 ${122 + (index - 21) / 14 * 63 + b} C67 ${39 + (index - 21) / 14 * 78 + b} 136 ${48 + (index - 21) / 14 * 74 + a * .6} 191 ${82 + (index - 21) / 14 * 66 + a * .6} C248 ${122 + (index - 21) / 14 * 58 - a * .5} 298 ${190 - (index - 21) / 14 * 14 - a * .5} 355 ${188 - (index - 21) / 14 * 10 + b * .3} C383 ${198 - (index - 21) / 14 * 13 + b * .3} 402 ${187 - (index - 21) / 14 * 8 + a * .25} 422 ${169 + (index - 21) / 14 * 13 + a * .25}`);
          return;
        }
        let data = "";
        for (let step = 0; step <= 66; step += 1) {
          const x = step * width / 66;
          const u = x / width;
          const drift = time * .51;
          const y = height * .64 + Math.sin(u * 8.4 - drift + progress * 2) * height * .22 + (progress - .5) * height * .47;
          data += `${step ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(2)}`;
        }
        path.setAttribute("d", data);
      });
    };
    const tick = (now: number) => {
      if (now - lastPaint >= 1000 / 30) {
        paint((now - start) / 1000);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      start = performance.now();
      paint(0);
      if (reducedMotion && !reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    reducedMotion?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion?.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [height, quiet, width]);

  return (
    <svg ref={ref} className={quiet ? "aboutWaves" : "historyWaves"} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id={gradientId}><stop stopColor="#71152c" stopOpacity="0" /><stop offset=".15" stopColor="#b7173e" stopOpacity=".48" /><stop offset=".54" stopColor="#ff4167" stopOpacity=".8" /><stop offset=".78" stopColor="#ff6482" /><stop offset="1" stopColor="#ff325e" stopOpacity=".56" /></linearGradient></defs>
      {Array.from({ length: count }, (_, index) => <path key={index} className="settingsWave" stroke={`url(#${gradientId})`} strokeWidth={index === 9 ? 1.2 : .65} opacity={quiet ? .64 : .55 + index % 5 * .09} />)}
      {stars.map((star, index) => <circle key={index} cx={star.x} cy={star.y} r={star.radius} fill="#fa4268" opacity={star.opacity} />)}
      {!quiet && <g className="databaseSparkle" style={{ "--delay": "-1.4s" } as CSSProperties}><path d="M343 23v14m-6-7h12" stroke="#ffa1b5" strokeWidth=".6" /><circle cx="343" cy="30" r="1.2" fill="#ffe3eb" /></g>}
    </svg>
  );
};

export const SettingsPlanet = () => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (navigator.userAgent.includes("jsdom")) return;
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const width = canvas.width, height = canvas.height, scale = width / 515, centerX = 344 * scale, centerY = 290 * scale, radius = 302 * scale;
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const dx = (x - centerX) / radius, dy = (y - centerY) / radius, radial = Math.hypot(dx, dy), edge = (1 - radial) * radius;
      const pixel = (y * width + x) * 4;
      if (radial > 1.12) continue;
      const illumination = clamp(.48 - dx * .8 - dy * .3, .08, 1.2);
      if (radial > 1) {
        const alpha = Math.exp(-(radial - 1) * 88) * .58 * illumination;
        image.data[pixel] = 255; image.data[pixel + 1] = 40; image.data[pixel + 2] = 82; image.data[pixel + 3] = 255 * alpha;
        continue;
      }
      const z = Math.sqrt(1 - dx * dx - dy * dy);
      const terrainNoise = fbm(dx * 18 + z * 7, dy * 21 + z * 5, 6);
      const crust = Math.pow(1 - Math.abs(noise(dx * 80 + 8 * terrainNoise, dy * 80 + 8 * terrainNoise) * 2 - 1), 4);
      const ridge = clamp((terrainNoise - .38) * 5, 0, 1) * crust;
      const rim = Math.exp(-Math.max(0, edge) / (2.2 * scale)) * illumination;
      const bloom = Math.exp(-Math.max(0, edge) / (15 * scale)) * illumination;
      const shade = clamp(.48 - dx * .78 - z * .55, .07, .95);
      const terrain = (10 + 61 * ridge + 26 * terrainNoise) * shade;
      image.data[pixel] = terrain + rim * 239 + bloom * 75;
      image.data[pixel + 1] = terrain * .14 + rim * 165 + bloom * 8;
      image.data[pixel + 2] = terrain * .34 + rim * 183 + bloom * 25;
      image.data[pixel + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, []);
  return <canvas ref={ref} className="settingsPlanet" width="1030" height="228" aria-hidden="true" />;
};

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
    for (let py = 0; py < low.height; py += 1) for (let px = 0; px < low.width; px += 1) {
      const x = px * 2 + 31, y = py * 2 + 24;
      const warp = (fbm(x * .003, y * .003) - .48) * 125;
      const n = fbm(x * .012 + warp * .014, y * .012 - warp * .012);
      const vein = 1 - Math.abs(2 * fbm(x * .017 + 2 * n, y * .017 + 3 * n) - 1);
      const band = Math.exp(-(((y - (x * .5 - 198 + 44 * Math.sin(x * .013)) + warp) / 83) ** 2));
      const perimeter = Math.exp(-(((x + warp) / 65) ** 2)) + Math.exp(-(((1404 - x + warp) / 60) ** 2)) + .7 * Math.exp(-(((1120 - y + warp) / 56) ** 2));
      const mask = Math.min(1.25, band * 1.2 + perimeter);
      const thread = Math.pow(clamp((vein - .62) * 3, 0, 1), 3.6);
      const detail = fbm(x * .032 + warp * .06, y * .032, 4);
      const hot = Math.pow(clamp((detail - .37) * 3, 0, 1), 2.5) * thread;
      const luminance = mask * (5 + 135 * Math.pow(n, 2.5) + 155 * thread * Math.pow(n, 1.5) + 220 * hot);
      const pixel = (py * low.width + px) * 4;
      image.data[pixel] = 5 + luminance;
      image.data[pixel + 1] = 3 + luminance * .13;
      image.data[pixel + 2] = 7 + luminance * .28;
      image.data[pixel + 3] = 255;
    }
    lowContext.putImageData(image, 0, 0);
    context.drawImage(low, 0, 0, canvas.width, canvas.height);
    const shade = context.createLinearGradient(0, 0, 0, canvas.height);
    shade.addColorStop(0, "rgba(0,0,3,.10)");
    shade.addColorStop(.12, "rgba(0,0,3,.55)");
    shade.addColorStop(1, "rgba(0,0,3,.70)");
    context.fillStyle = shade;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, []);
  return <canvas ref={ref} className="settingsAtmosphere" width="1342" height="1063" aria-hidden="true" />;
};
