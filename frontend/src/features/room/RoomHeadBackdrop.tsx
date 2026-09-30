import { useId } from "react";

// The reference's arc: a circle centred beyond the card's top right corner. It enters at the top at
// about 80 % of the width and leaves through the right edge near the bottom.
const arc = { cx: 1352, cy: -105, r: 470 };

/**
 * The room card's light, drawn in the card's own 1110 x 338 reference units and in the theme's
 * colours (--room-cool, --room-warm): a cool glow in the top left, and a warm glass region beyond a
 * glowing arc on the right, with thinner arcs inside it and a spark where the arc meets the top.
 */
export const RoomHeadBackdrop = () => {
  const id = useId().replace(/:/g, "");
  const ref = (name: string) => `url(#${id}${name})`;
  return (
    <svg className="roomHeadBackdrop" viewBox="0 0 1110 338" preserveAspectRatio="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}cool`} cx="0" cy="0" r="0.5" gradientTransform="scale(0.55 1)">
          <stop offset="0" stopColor="var(--room-cool)" stopOpacity="0.3" />
          <stop offset="1" stopColor="var(--room-cool)" stopOpacity="0" />
        </radialGradient>
        {/* Brightest along the arc, fading towards the corner. */}
        <radialGradient id={`${id}glass`} gradientUnits="userSpaceOnUse" cx={arc.cx} cy={arc.cy} r={arc.r}>
          <stop offset="0.55" stopColor="var(--room-warm)" stopOpacity="0.05" />
          <stop offset="0.9" stopColor="var(--room-warm)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--room-warm)" stopOpacity="0.3" />
        </radialGradient>
        <radialGradient id={`${id}spark`}>
          <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="0.3" stopColor="var(--room-warm)" stopOpacity="0.85" />
          <stop offset="1" stopColor="var(--room-warm)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}line`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--room-warm)" stopOpacity="0.95" />
          <stop offset="0.6" stopColor="var(--room-warm)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--room-warm)" stopOpacity="0.9" />
        </linearGradient>
        <filter id={`${id}glow`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect width="1110" height="338" fill={ref("cool")} />
      <circle cx={arc.cx} cy={arc.cy} r={arc.r} fill={ref("glass")} />
      <g fill="none" filter={ref("glow")}>
        <circle cx={arc.cx} cy={arc.cy} r={arc.r} stroke={ref("line")} strokeWidth="1.8" strokeOpacity="0.8" />
        <circle cx={arc.cx} cy={arc.cy} r={arc.r + 22} stroke="#ffffff" strokeOpacity="0.12" strokeWidth="1" />
        <circle cx={arc.cx} cy={arc.cy} r={arc.r - 26} stroke="var(--room-warm)" strokeOpacity="0.28" strokeWidth="1" />
        <circle cx={arc.cx} cy={arc.cy} r={arc.r - 58} stroke="var(--room-warm)" strokeOpacity="0.16" strokeWidth="0.8" />
      </g>
      <circle cx="894" cy="1" r="30" fill={ref("spark")} opacity="0.8" />
      <ellipse cx="894" cy="1" rx="70" ry="1.4" fill={ref("spark")} opacity="0.7" />
    </svg>
  );
};
