import { useEffect, useId, useRef } from "react";
import cx from "../../theme/ui/_internal/cx";

const SPEED = 145;

const lights = [
  { key: "tl", tone: "cool", color: "var(--frame-cool)", anchorX: .12, anchorY: 0, radius: 73, glint: false },
  { key: "bl", tone: "cool", color: "var(--frame-cool)", anchorX: 0, anchorY: .45, radius: 73, glint: false },
  { key: "tr", tone: "warm", color: "var(--frame-warm)", anchorX: 1, anchorY: .54, radius: 73, glint: false },
  { key: "br", tone: "warm", color: "var(--frame-warm)", anchorX: .87, anchorY: 1, radius: 73, glint: false },
  { key: "cool-glint", tone: "cool", color: "var(--frame-cool)", anchorX: .73, anchorY: 0, radius: 24, glint: true },
  { key: "warm-glint", tone: "warm", color: "var(--frame-warm)", anchorX: .93, anchorY: 0, radius: 33.5, glint: true },
] as const;

type MovingLight = {
  gradients: SVGRadialGradientElement[];
  filter: SVGFilterElement | null;
  padding: number;
  anchorX: number;
  anchorY: number;
  phase: number | null;
};

export const fitAnimatedFrameGeometry = (width: number, height: number, borderRadius: number, strokeWidth = 1) => {
  const x = strokeWidth / 2;
  const y = x;
  const rx = Math.max(0, Math.min(borderRadius - x, (width - strokeWidth) / 2));
  const ry = Math.max(0, Math.min(borderRadius - y, (height - strokeWidth) / 2));
  return { viewBox: `0 0 ${width} ${height}`, x, y, width: width - strokeWidth, height: height - strokeWidth, rx, ry };
};

export const AnimatedNeonFrame = ({ className }: { className?: string }) => {
  const frameRef = useRef<SVGSVGElement | null>(null);
  const prefix = `animated-frame-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    const svg = frameRef.current;
    const guide = svg?.querySelector<SVGRectElement>(":scope > rect");
    if (!svg || !guide || typeof guide.getTotalLength !== "function") return;
    const moving: MovingLight[] = lights.map(light => ({
      gradients: [...svg.querySelectorAll<SVGRadialGradientElement>(`[data-frame-light="${light.key}"]`)],
      filter: svg.querySelector<SVGFilterElement>(`[data-frame-filter="${light.key}"]`),
      padding: light.radius * (light.glint ? 1.3 : 1) + 18,
      anchorX: light.anchorX,
      anchorY: light.anchorY,
      phase: null,
    }));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let length = 0;
    let frame = 0;
    let previous: number | undefined;

    const paint = () => {
      if (!length) return;
      for (const light of moving) {
        if (light.phase === null) continue;
        const point = guide.getPointAtLength(light.phase * length);
        const x = point.x.toFixed(3);
        const y = point.y.toFixed(3);
        for (const gradient of light.gradients) {
          gradient.setAttribute("cx", x);
          gradient.setAttribute("cy", y);
        }
        light.filter?.setAttribute("x", (point.x - light.padding).toFixed(3));
        light.filter?.setAttribute("y", (point.y - light.padding).toFixed(3));
      }
    };

    const fit = () => {
      const owner = svg.parentElement;
      if (!owner) return false;
      const style = getComputedStyle(owner);
      const width = Number.parseFloat(style.width);
      const height = Number.parseFloat(style.height);
      if (!(width > 1 && height > 1)) return false;
      const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      const geometry = fitAnimatedFrameGeometry(width, height, radius);
      svg.setAttribute("viewBox", geometry.viewBox);
      Object.assign(svg.style, {
        inset: "auto",
        left: `${-borderLeft}px`,
        top: `${-borderTop}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      for (const rect of svg.querySelectorAll<SVGRectElement>(":scope > rect")) {
        for (const [name, value] of Object.entries(geometry)) {
          if (name !== "viewBox") rect.setAttribute(name, String(value));
        }
      }
      length = guide.getTotalLength();
      if (!length) return false;
      const count = Math.max(16, Math.ceil(length / 3));
      const samples = Array.from({ length: count }, (_, index) => ({
        phase: index / count,
        point: guide.getPointAtLength(index / count * length),
      }));
      for (const light of moving) {
        const x = light.anchorX * width;
        const y = light.anchorY * height;
        const nearest = samples.reduce((best, sample) => {
          const distance = (sample.point.x - x) ** 2 + (sample.point.y - y) ** 2;
          return distance < best.distance ? { phase: sample.phase, distance } : best;
        }, { phase: 0, distance: Infinity });
        if (light.phase === null || reducedMotion.matches) light.phase = nearest.phase;
      }
      paint();
      return true;
    };

    const tick = (time: number) => {
      if (previous !== undefined && length) {
        const distance = Math.min(time - previous, 64) / 1_000 * SPEED;
        for (const light of moving) {
          if (light.phase !== null) light.phase = (light.phase + distance / length) % 1;
        }
      }
      previous = time;
      paint();
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      previous = undefined;
      if (!fit()) return;
      if (!reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };

    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    if (svg.parentElement) resize?.observe(svg.parentElement, { box: "border-box" });
    reducedMotion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      reducedMotion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const id = (key: string, suffix = "") => `${prefix}-${key}${suffix}`;
  return (
    <svg ref={frameRef} className={cx("animatedNeonFrame frame-lines", className)} viewBox="0 0 386 86"
      preserveAspectRatio="xMidYMid meet" fill="none" aria-hidden>
      <defs>
        {lights.flatMap(light => {
          const auraRadius = light.radius * (light.glint ? 1.3 : 1);
          const padding = auraRadius + 18;
          return [
            <radialGradient key={`${light.key}-core`} id={id(light.key)} data-frame-light={light.key}
              data-frame-tone={light.tone} gradientUnits="userSpaceOnUse" r={light.radius} cx={light.anchorX * 386} cy={light.anchorY * 86}>
              <stop offset="0" stopColor="var(--frame-highlight)" stopOpacity=".95" />
              <stop offset={light.glint ? ".18" : ".22"} stopColor={light.color} stopOpacity=".9" />
              <stop offset=".54" stopColor={light.color} stopOpacity=".38" />
              <stop offset="1" stopColor={light.color} stopOpacity="0" />
            </radialGradient>,
            <radialGradient key={`${light.key}-aura`} id={id(light.key, "-aura")} data-frame-light={light.key}
              gradientUnits="userSpaceOnUse" r={auraRadius} cx={light.anchorX * 386} cy={light.anchorY * 86}>
              <stop offset="0" stopColor={light.color} stopOpacity=".9" />
              <stop offset=".4" stopColor={light.color} stopOpacity=".5" />
              <stop offset="1" stopColor={light.color} stopOpacity="0" />
            </radialGradient>,
            <filter key={`${light.key}-filter`} id={id(light.key, "-blur")} data-frame-filter={light.key}
              filterUnits="userSpaceOnUse" width={padding * 2} height={padding * 2} colorInterpolationFilters="linearRGB">
              <feGaussianBlur stdDeviation="3" />
            </filter>,
          ];
        })}
      </defs>
      {lights.flatMap(light => [
        <rect key={`${light.key}-aura`} x=".5" y=".5" width="385" height="85" rx="15.5"
          className={light.glint ? "travelling-edge-glint" : undefined}
          stroke={`url(#${id(light.key, "-aura")})`} strokeWidth={light.glint ? 8 : 5}
          opacity={light.glint ? .6 : .75} filter={`url(#${id(light.key, "-blur")})`} />,
        <rect key={`${light.key}-core`} x=".5" y=".5" width="385" height="85" rx="15.5"
          className={light.glint ? "travelling-edge-glint" : undefined}
          stroke={`url(#${id(light.key)})`} strokeWidth={light.glint ? 1.15 : 1}
          opacity={light.glint ? .95 : 1} />,
      ])}
    </svg>
  );
};
