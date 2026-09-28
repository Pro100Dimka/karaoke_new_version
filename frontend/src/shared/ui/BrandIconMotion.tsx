import { useId } from "react";
import "./brand-icon-motion.css";

const viewBoxSize = 500;

interface BrandIconMotionProps {
  src: string;
  className?: string;
  glow?: boolean;
  colors?: { primary: string; highlight: string };
}

/** The startup-loader motion clipped to the non-transparent pixels of a brand icon. */
export const BrandIconMotion = ({ src, className = "", glow = true, colors }: BrandIconMotionProps) => {
  const maskId = useId();
  const sweepId = useId();
  const primary = colors?.primary ?? "var(--ui-primary)";
  const highlight = colors?.highlight ?? "var(--color-highlight)";

  return (
    <svg
      className={`brandIconMotion ${className}`.trim()}
      data-glow={glow}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      aria-hidden
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={viewBoxSize} height={viewBoxSize} style={{ maskType: "alpha" }}>
          <image href={src} width={viewBoxSize} height={viewBoxSize} />
        </mask>
        <linearGradient id={sweepId} x1="0" y1="0" x2="1" y2="0">
          <stop className="brandIconMotionSweepAccent" offset="0" stopColor={primary} stopOpacity="0" />
          <stop offset="0.42" stopColor={primary} stopOpacity="0.58" />
          <stop className="brandIconMotionSweepHighlight" offset="0.5" stopColor={highlight} stopOpacity="0.92" />
          <stop offset="0.58" stopColor={primary} stopOpacity="0.58" />
          <stop offset="1" stopColor={primary} stopOpacity="0" />
        </linearGradient>
      </defs>
      <image className="brandIconMotionImage" href={src} width={viewBoxSize} height={viewBoxSize} />
      <g mask={`url(#${maskId})`}>
        <rect className="brandIconMotionSweep" x={-viewBoxSize / 2} y="0" width={viewBoxSize / 2} height={viewBoxSize} fill={`url(#${sweepId})`} />
      </g>
    </svg>
  );
};
