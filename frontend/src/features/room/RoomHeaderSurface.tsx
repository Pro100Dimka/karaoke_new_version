import { AnimatedNeonFrame, fitAnimatedFrameGeometry } from "../../shared/ui/AnimatedNeonFrame";

export const fitHeaderFrameGeometry = fitAnimatedFrameGeometry;

/** The header material from karaoke-room-host-orbit-fixed.html with the shared fitted SVG frame. */
export const RoomHeaderSurface = () => (
  <span className="roomSurface roomSurface--header surface surface--header" aria-hidden>
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
    <AnimatedNeonFrame className="roomSurfaceFrame" />
  </span>
);
