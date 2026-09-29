import { memo } from "react";
import knobBody from "../../../assets/rotary-knob/knob-body.png";
import knobPointer from "../../../assets/rotary-knob/knob-pointer.png";
import thumbArtwork from "../../../assets/rotary-knob/thumb.png";
import trackActive from "../../../assets/rotary-knob/track-active.png";

const pointOnDial = (angle: number, radius: number) => {
  const radians = (angle * Math.PI) / 180;
  return {
    x: 100 + Math.cos(radians) * radius,
    y: 100 + Math.sin(radians) * radius,
  };
};

/** Static dial artwork is independent of playback position and fresh event callbacks. */
export const RotaryKnobArtwork = memo(function RotaryKnobArtwork({ id, ratio }: { id: string; ratio: number }) {
  const dialAngle = 135 + ratio * 270;
  const thumb = pointOnDial(dialAngle, 72);
  return (
    <span
      className="ui-rotary-knob__control ui-rotary-knob__reference-shell"
      aria-hidden
    >
      <svg
        className="ui-rotary-knob__artwork"
        viewBox="0 0 200 200"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <mask
            id={`${id}-track`}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="200"
            height="200"
          >
            <circle
              cx="100"
              cy="100"
              r="72"
              fill="none"
              stroke="#fff"
              strokeWidth="8"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray="75 100"
              transform="rotate(135 100 100)"
            />
          </mask>
          <mask
            id={`${id}-progress`}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="200"
            height="200"
          >
            <circle
              cx="100"
              cy="100"
              r="72"
              fill="none"
              stroke="#fff"
              strokeWidth="9"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray={`${ratio * 75} 100`}
              transform="rotate(135 100 100)"
            />
          </mask>
          <clipPath id={`${id}-pointer-half`}>
            <path d="M100 100 L137 56 L144 100 Z" />
          </clipPath>
          <clipPath id={`${id}-body-circle`}>
            <circle cx="100" cy="100" r="59.2" />
          </clipPath>
        </defs>

        <g mask={`url(#${id}-track)`}>
          <svg
            className="ui-rotary-knob__track-inactive-art"
            x="10"
            y="10"
            width="180"
            height="180"
            viewBox="0 0 1254 1254"
            preserveAspectRatio="none"
          >
            <image
              href={trackActive}
              x="0"
              y="0"
              width="1254"
              height="1254"
            />
          </svg>
        </g>
        <circle
          className="ui-rotary-knob__track-inactive-cap"
          cx={pointOnDial(405, 72).x}
          cy={pointOnDial(405, 72).y}
          r="3"
          fill="#363941"
        />
        <g mask={`url(#${id}-progress)`}>
          <svg
            className="ui-rotary-knob__track-active-art"
            x="10"
            y="10"
            width="180"
            height="180"
            viewBox="0 0 1254 1254"
            preserveAspectRatio="none"
          >
            <image
              href={trackActive}
              x="0"
              y="0"
              width="1254"
              height="1254"
            />
          </svg>
        </g>
        <circle
          className="ui-rotary-knob__track-active-cap"
          cx={pointOnDial(135, 72).x}
          cy={pointOnDial(135, 72).y}
          r="3"
          fill="var(--rotary-accent)"
          opacity={ratio > 0 ? 1 : 0}
        />
        <circle
          className="ui-rotary-knob__track-active-cap-core"
          cx={pointOnDial(135, 72).x}
          cy={pointOnDial(135, 72).y}
          r="1.55"
          fill="var(--color-text)"
          opacity={ratio > 0 ? 1 : 0}
        />
        <g
          className="ui-rotary-knob__rotating-dial"
          transform={`rotate(${dialAngle + 45} 100 100)`}
          style={{ transition: "none" }}
          clipPath={`url(#${id}-body-circle)`}
        >
          <svg
            className="ui-rotary-knob__body-art"
            x="36"
            y="36"
            width="128"
            height="128"
            viewBox="50 33.5 1157 1157"
            preserveAspectRatio="none"
          >
            <image href={knobBody} x="0" y="0" width="1254" height="1254" />
          </svg>
          <g
            className="ui-rotary-knob__pointer-art"
            clipPath={`url(#${id}-pointer-half)`}
          >
            <svg
              x="56"
              y="56"
              width="88"
              height="88"
              viewBox="57.5 57 1177 1177"
              preserveAspectRatio="none"
            >
              <image
                href={knobPointer}
                x="0"
                y="0"
                width="1254"
                height="1254"
              />
            </svg>
          </g>
        </g>
        <svg
          className="ui-rotary-knob__thumb-art"
          x={thumb.x - 13}
          y={thumb.y - 13}
          width="26"
          height="26"
          viewBox="20 5 1207 1207"
          preserveAspectRatio="none"
        >
          <image href={thumbArtwork} x="0" y="0" width="1254" height="1254" />
        </svg>
      </svg>
    </span>
  );
});
