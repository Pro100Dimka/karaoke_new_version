import type { PointerEvent } from "react";

interface CardTiltOptions<E extends HTMLElement> {
  isNeon: boolean;
  tilt: boolean;
  extraPositionVars?: readonly (readonly [string, string])[];
  onPointerMove?: (event: PointerEvent<E>) => void;
  onPointerLeave?: (event: PointerEvent<E>) => void;
}

/** Pointer-driven neon tilt/glow: only CSS custom-property side effects live here. */
export default function useCardTilt<E extends HTMLElement>({
  isNeon,
  tilt,
  extraPositionVars = [],
  onPointerMove,
  onPointerLeave
}: CardTiltOptions<E>) {
  const handlePointerMove = (event: PointerEvent<E>) => {
    if (isNeon) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      const { style } = event.currentTarget;

      style.setProperty("--card-mx", `${x}%`);
      style.setProperty("--card-my", `${y}%`);
      for (const [xName, yName] of extraPositionVars) {
        style.setProperty(xName, `${x}%`);
        style.setProperty(yName, `${y}%`);
      }

      if (tilt) {
        style.setProperty("--tilt-x", `${(0.5 - y / 100) * 8}deg`);
        style.setProperty("--tilt-y", `${(x / 100 - 0.5) * 10}deg`);
      }
    }
    onPointerMove?.(event);
  };

  const handlePointerLeave = (event: PointerEvent<E>) => {
    if (isNeon) {
      const names = ["--card-mx", "--card-my", ...extraPositionVars.flat()];
      if (tilt) names.push("--tilt-x", "--tilt-y");
      for (const name of names) event.currentTarget.style.removeProperty(name);
    }
    onPointerLeave?.(event);
  };

  return { handlePointerMove, handlePointerLeave };
}
