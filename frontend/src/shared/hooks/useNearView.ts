import { useEffect, useState, type RefObject } from "react";

/**
 * Whether an element has come near the visible part of its scroll area (within `margin`); it stays
 * true from then on. Heavy parts of long lists (waveforms with their animations) mount only then.
 * Without IntersectionObserver everything counts as in view.
 */
export const useNearView = (
  ref: RefObject<Element | null>,
  margin = "200px",
): boolean => {
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, margin, near]);
  return near;
};
