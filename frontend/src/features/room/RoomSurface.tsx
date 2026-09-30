import { useId } from "react";
import { AnimatedNeonFrame } from "../../shared/ui/AnimatedNeonFrame";

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

/** Decorative glass, ribbons and travelling frame energy taken from the supplied HTML reference. */
export const RoomSurface = ({ variant }: { variant: SurfaceVariant }) => {
  const id = useId().replaceAll(":", "");
  const geometry = surfaceGeometry[variant];
  const ribbonId = `room-ribbon-${id}`;
  const grainId = `room-grain-${id}`;

  return (
    <span className={`roomSurface roomSurface--${variant}`} aria-hidden>
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
      <AnimatedNeonFrame className="roomSurfaceFrame" />
    </span>
  );
};
