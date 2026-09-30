import { useEffect, useRef } from "react";
import headerFrame from "./room-header-frame.svg?raw";

const FRAME_SPEED = 145;

type HeaderLight = {
  gradients: SVGRadialGradientElement[];
  filter: SVGFilterElement | null;
  padding: number;
  phase: number;
};

/** The header surface copied from karaoke-room-host-orbit-fixed.html, including its fitted neon frame. */
export const RoomHeaderSurface = () => {
  const surfaceRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const svg = surfaceRef.current?.querySelector<SVGSVGElement>(".frame-lines");
    const guide = svg?.querySelector<SVGRectElement>(":scope > rect");
    const defs = svg?.querySelector("defs");
    if (!svg || !guide || !defs || typeof guide.getTotalLength !== "function") return;

    const gradients = [...defs.querySelectorAll<SVGRadialGradientElement>("radialGradient")];
    const cores = gradients.filter(gradient => !gradient.id.endsWith("-aura"));
    const length = guide.getTotalLength();
    if (!length) return;
    const sampleCount = Math.max(16, Math.ceil(length / 3));
    const samples = Array.from({ length: sampleCount }, (_, index) => ({
      phase: index / sampleCount,
      point: guide.getPointAtLength(index / sampleCount * length),
    }));
    const lights: HeaderLight[] = cores.map(core => {
      const aura = gradients.find(gradient => gradient.id === `${core.id}-aura`);
      const x = Number(core.getAttribute("cx"));
      const y = Number(core.getAttribute("cy"));
      const nearest = samples.reduce((best, sample) => {
        const distance = (sample.point.x - x) ** 2 + (sample.point.y - y) ** 2;
        return distance < best.distance ? { phase: sample.phase, distance } : best;
      }, { phase: 0, distance: Infinity });
      return {
        gradients: aura ? [core, aura] : [core],
        filter: aura ? defs.querySelector<SVGFilterElement>(`#${CSS.escape(`${aura.id}-moving-blur`)}`) : null,
        padding: aura ? Number(aura.getAttribute("r")) + 18 : 0,
        phase: nearest.phase,
      };
    });

    const paint = () => {
      for (const light of lights) {
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

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous: number | undefined;
    const tick = (time: number) => {
      if (previous !== undefined) {
        const distance = Math.min(time - previous, 64) / 1_000 * FRAME_SPEED;
        for (const light of lights) light.phase = (light.phase + distance / length) % 1;
      }
      previous = time;
      paint();
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      previous = undefined;
      paint();
      if (!reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    reducedMotion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <span ref={surfaceRef} className="roomSurface roomSurface--header surface surface--header" aria-hidden>
      <span className="roomSurfaceInterior surface-interior">
        <svg className="roomSurfaceRibbons ribbons" viewBox="0 0 632 193" preserveAspectRatio="none" fill="none">
          <defs>
            <linearGradient id="ribbon-header" x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#a3082f" stopOpacity=".12" />
              <stop offset=".47" stopColor="#7c1632" stopOpacity=".30" />
              <stop offset=".65" stopColor="#e91a41" stopOpacity=".15" />
              <stop offset="1" stopColor="#510a21" stopOpacity=".03" />
            </linearGradient>
          </defs>
          <path d="M476 -36 C638 61 505 176 344 199 L376 203 C553 162 645 48 495 -35Z" fill="url(#ribbon-header)" />
          <path d="M476 -31 C635 65 504 179 348 196 M495 -31 C650 65 522 180 376 199" stroke="#ff2b53" strokeOpacity=".24" strokeWidth=".65" />
          <path d="M487 -23 C615 56 541 132 491 151" stroke="#ff2644" strokeOpacity=".12" strokeWidth="9" />
          <path d="M498 -30 C651 82 522 211 370 221" stroke="#2a88b1" strokeOpacity=".16" strokeWidth=".5" />
        </svg>
        <svg className="roomSurfaceGrain grain" width="100%" height="100%">
          <filter id="material-grain-header" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency=".86" numOctaves="3" seed="8" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#material-grain-header)" />
        </svg>
      </span>
      <span className="roomHeaderFrameSource" dangerouslySetInnerHTML={{ __html: headerFrame }} />
    </span>
  );
};
