import { useEffect, useId, useRef } from "react";

type SurfaceVariant = "header" | "host" | "guest" | "network";

const surfaceGeometry: Record<SurfaceVariant, { height: number; ribbon: string; curves: string }> = {
  header: {
    height: 193,
    ribbon: "M476 -36 C638 61 505 176 344 199 L376 203 C553 162 645 48 495 -35Z",
    curves: "M476 -31 C635 65 504 179 348 196 M495 -31 C650 65 522 180 376 199",
  },
  host: {
    height: 142,
    ribbon: "M419 -16 C449 29 489 111 556 148 L605 145 C520 70 498 32 476 -16Z",
    curves: "M422 -10 C448 42 495 109 560 147 M437 -10 C467 55 510 103 578 147",
  },
  guest: {
    height: 143,
    ribbon: "M419 -16 C449 29 489 111 556 149 L605 146 C520 70 498 32 476 -16Z",
    curves: "M422 -10 C448 42 495 109 560 148 M437 -10 C467 55 510 103 578 148",
  },
  network: {
    height: 104,
    ribbon: "M563 -14 C525 16 510 55 436 112 L491 113 C560 66 571 18 611 -9Z",
    curves: "M563 -14 C525 16 510 55 436 112 M599 -13 C547 34 548 64 473 114",
  },
};

const frameColors: Record<SurfaceVariant, readonly string[]> = {
  header: ["#7bd7ff", "#7bd7ff", "#ff4768", "#ff3154", "#56c5ff", "#ff123d"],
  host: ["#ff344e", "#69d2ff", "#ff3154", "#ff5b76", "#56c5ff"],
  guest: ["#7bd7ff", "#55c8ff", "#ff6583", "#ff4d70", "#56c5ff", "#ff123d"],
  network: ["#ff344e", "#ff5371", "#ff3154", "#ff7190", "#ff123d"],
};

const useTravellingFrame = (surface: React.RefObject<HTMLSpanElement | null>) => {
  useEffect(() => {
    const element = surface.current;
    const svg = element?.querySelector<SVGSVGElement>(".roomSurfaceFrame");
    const guide = svg?.querySelector<SVGRectElement>(".roomSurfaceFrameBase");
    const gradients = svg ? [...svg.querySelectorAll<SVGRadialGradientElement>(".roomSurfaceMovingGradient")] : [];
    if (!element || !svg || !guide || typeof guide.getTotalLength !== "function" || gradients.length === 0) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const phases = gradients.map((_, index) => index / gradients.length);
    let length = 0;
    let frame = 0;
    let previous: number | undefined;

    const fit = () => {
      const style = getComputedStyle(element);
      const width = Number.parseFloat(style.width);
      const height = Number.parseFloat(style.height);
      if (!(width > 1 && height > 1)) return;
      const inset = .5;
      const radius = Math.max(0, Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2) - inset);
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      for (const rect of svg.querySelectorAll<SVGRectElement>(":scope > rect")) {
        rect.setAttribute("x", String(inset));
        rect.setAttribute("y", String(inset));
        rect.setAttribute("width", String(width - inset * 2));
        rect.setAttribute("height", String(height - inset * 2));
        rect.setAttribute("rx", String(radius));
      }
      length = guide.getTotalLength();
    };
    const paint = () => gradients.forEach((gradient, index) => {
      if (!length) return;
      const point = guide.getPointAtLength((phases[index] ?? 0) * length);
      gradient.setAttribute("cx", point.x.toFixed(3));
      gradient.setAttribute("cy", point.y.toFixed(3));
    });
    const tick = (time: number) => {
      if (previous !== undefined && length) {
        const distance = Math.min(time - previous, 64) / 1_000 * 145;
        phases.forEach((phase, index) => { phases[index] = (phase + distance / length) % 1; });
      }
      previous = time;
      paint();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      previous = undefined;
      fit();
      paint();
      if (!media.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    start();
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(start);
    resize?.observe(element, { box: "border-box" });
    media.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      media.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", start);
    };
  }, [surface]);
};

/** Decorative glass, ribbons and travelling frame energy taken from the supplied HTML reference. */
export const RoomSurface = ({ variant }: { variant: SurfaceVariant }) => {
  const id = useId().replaceAll(":", "");
  const surface = useRef<HTMLSpanElement>(null);
  useTravellingFrame(surface);
  const geometry = surfaceGeometry[variant];
  const ribbonId = `room-ribbon-${id}`;
  const grainId = `room-grain-${id}`;
  const colors = frameColors[variant];

  return (
    <span ref={surface} className={`roomSurface roomSurface--${variant}`} aria-hidden>
      <span className="roomSurfaceInterior">
        <svg className="roomSurfaceRibbons" viewBox={`0 0 632 ${geometry.height}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id={ribbonId} x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#a3082f" stopOpacity=".12" />
              <stop offset=".47" stopColor="#7c1632" stopOpacity=".30" />
              <stop offset=".65" stopColor="#e91a41" stopOpacity=".15" />
              <stop offset="1" stopColor="#510a21" stopOpacity=".03" />
            </linearGradient>
          </defs>
          <path className="roomSurfaceRibbonFill" d={geometry.ribbon} fill={`url(#${ribbonId})`} />
          <path className="roomSurfaceRibbonLines" d={geometry.curves} />
        </svg>
        <svg className="roomSurfaceGrain" width="100%" height="100%">
          <filter id={grainId} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency=".78" numOctaves="3" seed="17" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#${grainId})`} />
        </svg>
      </span>
      <svg className="roomSurfaceFrame" viewBox={`0 0 632 ${geometry.height}`} preserveAspectRatio="none" fill="none">
        <defs>
          {colors.map((color, index) => <radialGradient key={index} id={`room-frame-${id}-${index}`}
            className="roomSurfaceMovingGradient" gradientUnits="userSpaceOnUse" cx="0" cy="0" r={index > 3 ? 58 : 74}>
            <stop stopColor="#fff7fa" stopOpacity=".98" />
            <stop offset=".18" stopColor={color} stopOpacity=".9" />
            <stop offset=".52" stopColor={color} stopOpacity=".38" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </radialGradient>)}
        </defs>
        <rect className="roomSurfaceFrameBase" x="1" y="1" width="630" height={geometry.height - 2} rx="20" />
        {colors.map((_, index) => <rect key={index} className="roomSurfaceMovingLight"
          x="1" y="1" width="630" height={geometry.height - 2} rx="20"
          stroke={`url(#room-frame-${id}-${index})`} strokeWidth={index > 3 ? 3.4 : 1.15} />)}
      </svg>
    </span>
  );
};
