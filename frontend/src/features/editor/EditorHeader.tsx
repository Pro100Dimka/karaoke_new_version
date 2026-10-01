import { useEffect, useRef, type ReactNode } from "react";
import { desktopClient } from "../../services/desktopClient";
import defs from "./assets/melody-editor-defs.svg?raw";
import landscape from "./assets/melody-editor-header.svg?raw";
import cover from "./assets/melody-editor-cover.svg?raw";
import wordmark from "./assets/melody-editor-wordmark.svg?raw";

export const ReferenceArt = ({ markup, className = "me-reference-art" }: { markup: string; className?: string }) => (
  <div className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />
);

export const MeIcon = ({ name, className = "" }: { name: string; className?: string }) => (
  <svg className={`me-icon ${className}`} aria-hidden="true" focusable="false">
    <use href={`#me-i-${name}`} />
  </svg>
);

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

const paintHeader = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d");
  if (!context) return false;
  let seed = 37419;
  const random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value ^= value + Math.imul(value ^ value >>> 7, 61 | value); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  const table = Float32Array.from({ length: 65536 }, random);
  const noise = (x: number, y: number) => { const ix = Math.floor(x), iy = Math.floor(y); let u = x - ix, v = y - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); const n = (a: number, b: number) => table[(a & 255) + ((b & 255) << 8)] ?? 0; return (n(ix, iy) * (1 - u) + n(ix + 1, iy) * u) * (1 - v) + (n(ix, iy + 1) * (1 - u) + n(ix + 1, iy + 1) * u) * v; };
  const fbm = (x: number, y: number, count = 5) => { let sum = 0, amplitude = .5; for (let index = 0; index < count; index++) { sum += amplitude * noise(x, y); x = x * 2.13 + 21.3; y = y * 2.13 - 7.6; amplitude *= .5; } return sum; };
  const image = context.createImageData(1280, 83);
  for (let y = 0; y < 83; y++) for (let x = 0; x < 1280; x++) {
    const edge = 323 - Math.hypot(x - 398, y - 105);
    const haze = Math.exp(-(((x - 716) / 145) ** 2)) * Math.exp(-(((y - 52) / 72) ** 2));
    const clouds = fbm(x * .021, y * .032);
    let red = 5 + 44 * haze * (.4 + clouds), green = 5 + 13 * haze, blue = 10 + 20 * haze;
    if (edge > 0) {
      const illumination = clamp((x - 360) / 363, 0, 1), n = fbm(x * .032, y * .045, 6), cracks = Math.pow(1 - Math.abs(2 * noise(x * .082 + n * 7, y * .1 + n * 8) - 1), 5), ridges = clamp((n - .38) * 4, 0, 1) * cracks;
      red = 6 + (38 * n + 110 * ridges) * illumination ** 2; green = 5 + (16 * n + 12 * ridges) * illumination ** 2; blue = 10 + (28 * n + 38 * ridges) * illumination ** 2;
      const rim = Math.exp(-edge / 1.75), bloom = Math.exp(-edge / 14); red += 232 * rim + 80 * bloom; green += 157 * rim + 26 * bloom; blue += 149 * rim + 34 * bloom;
    } else { const rim = Math.exp(edge / 2.5), bloom = Math.exp(edge / 15); red += 175 * rim + 75 * bloom; green += 72 * rim + 9 * bloom; blue += 96 * rim + 22 * bloom; }
    const vignette = clamp(Math.min((x - 330) / 210, (1130 - x) / 270), .05, 1), pixel = (y * 1280 + x) * 4;
    image.data[pixel] = red * vignette; image.data[pixel + 1] = green * vignette; image.data[pixel + 2] = blue * vignette; image.data[pixel + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  context.save(); context.globalCompositeOperation = "screen"; context.translate(717, 54); context.scale(2.35, 1); const horizon = context.createRadialGradient(0, 0, 0, 0, 0, 68); horizon.addColorStop(0, "rgba(255,166,139,.72)"); horizon.addColorStop(.24, "rgba(255,77,94,.53)"); horizon.addColorStop(1, "rgba(208,25,58,0)"); context.fillStyle = horizon; context.fillRect(-70, -70, 140, 140); context.restore();
  const water = context.createLinearGradient(0, 59, 0, 83); water.addColorStop(0, "#50232c"); water.addColorStop(.3, "#221923"); water.addColorStop(1, "#06080c"); context.fillStyle = water; context.fillRect(360, 60, 690, 23);
  for (let index = 0; index < 1700; index++) { const x = 370 + random() * 660, y = 60 + random() * 23, falloff = Math.exp(-(((x - 717) / (32 + (y - 59) * 2.3)) ** 2)); context.strokeStyle = `rgba(255,${105 + Math.floor(random() * 75)},${117 + Math.floor(random() * 72)},${falloff * (.12 + random() * .42)})`; context.lineWidth = .22 + random() * .5; context.beginPath(); context.moveTo(x, y); context.lineTo(x + 2 + random() * 18, y); context.stroke(); }
  for (let layer = 0; layer < 5; layer++) { const ridge: [number, number][] = []; for (let x = 345; x <= 1020; x += 3) { const distance = Math.abs(x - 715) / 360, detail = fbm(x * .049 + layer * 3.4, layer * 14), y = 60 - (7 + Math.pow(distance, 1.4) * 63) * (1 - layer * .12) * (detail * .85 + .55); ridge.push([x, y]); } context.fillStyle = ["#32202b", "#251722", "#180f1a", "#0d0c13", "#05080d"][layer] ?? "#05080d"; context.beginPath(); context.moveTo(345, 64); ridge.forEach(([x, y]) => context.lineTo(x, y)); context.lineTo(1020, 64); context.closePath(); context.fill(); }
  const fade = context.createLinearGradient(0, 0, 1280, 0); fade.addColorStop(0, "#040509d9"); fade.addColorStop(.29, "#040509cb"); fade.addColorStop(.42, "#0405090a"); fade.addColorStop(.64, "#04050900"); fade.addColorStop(.84, "#040509d9"); fade.addColorStop(1, "#040509f5"); context.fillStyle = fade; context.fillRect(0, 0, 1280, 83);
  return true;
};

const WindowButton = ({ label, icon, children, onClick }: {
  label: string;
  icon?: string;
  children?: ReactNode;
  onClick(): void;
}) => (
  <button className="me-glass" type="button" title={label} aria-label={label} onClick={onClick}>
    {icon ? <MeIcon name={icon} /> : children}
  </button>
);

export const EditorHeader = ({ title, revision, dirty, onBack }: {
  title: string;
  revision: number;
  dirty: boolean;
  onBack(): void;
}) => {
  const header = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current && paintHeader(canvas.current)) header.current?.classList.add("me-header-painted");
  }, []);
  return <header className="me-header" ref={header}>
    <ReferenceArt markup={defs} />
    <ReferenceArt markup={landscape} />
    <canvas ref={canvas} className="me-header-canvas" width={1280} height={83} aria-hidden="true" />
    <button className="me-glass me-back" type="button" onClick={onBack}>
      <MeIcon name="back" />
      <span>Назад</span>
    </button>
    <div className="me-cover"><ReferenceArt markup={cover} /></div>
    <h1>Редактор мелодии</h1>
    <p className="me-subtitle">
      {title} · Проект v{revision}
      {dirty && <span className="me-dirty">●</span>}
    </p>
    <div className="me-signature">
      <ReferenceArt markup={wordmark} />
      <span>KARAOKE STUDIO</span>
    </div>
    <div className="me-window-controls">
      <WindowButton label="Свернуть" onClick={() => void desktopClient.minimize()}>−</WindowButton>
      <WindowButton label="Развернуть" icon="window" onClick={() => void desktopClient.toggleMaximize()} />
      <WindowButton label="Закрыть" icon="close" onClick={onBack} />
    </div>
    <button className="me-glass me-settings" type="button" aria-label="Настройки">
      <MeIcon name="settings" />
    </button>
  </header>;
};
