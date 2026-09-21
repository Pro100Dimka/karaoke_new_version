import { useId } from "react";
import { useApp } from "../../app/AppContext";
import { themeIcons } from "./themeIcons";
import "./brand-loader.css";

const viewBoxSize = 500;

/**
 * Startup loader: only the theme icon, glowing in the theme colour, with a light sweep that runs across the icon's
 * own shape. The label is for screen readers. All motion is CSS, so the global reduced-motion rule stills it.
 */
export const BrandLoader = ({ label }: { label: string }) => {
  const { theme } = useApp();
  const maskId = useId();
  const sweepId = useId();
  const icon = themeIcons[theme];

  return (
    <div className="brandLoader" role="status" aria-live="polite" aria-label={label}>
      <svg className="brandLoaderSvg" viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`} aria-hidden>
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={viewBoxSize} height={viewBoxSize} style={{ maskType: "alpha" }}>
            <image href={icon} width={viewBoxSize} height={viewBoxSize} />
          </mask>
          <linearGradient id={sweepId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <image className="brandLoaderIcon" href={icon} width={viewBoxSize} height={viewBoxSize} />
        <g mask={`url(#${maskId})`}>
          <rect className="brandLoaderSweep" x={-viewBoxSize / 2} y="0" width={viewBoxSize / 2} height={viewBoxSize} fill={`url(#${sweepId})`} />
        </g>
      </svg>
    </div>
  );
};
