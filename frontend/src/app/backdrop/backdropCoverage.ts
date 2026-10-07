import { useEffect, useSyncExternalStore } from "react";

const covers = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const covered = () => covers.size > 0;

export const useBackdropCovered = (): boolean =>
  useSyncExternalStore(subscribe, covered, () => false);

/** Suspend the hidden WebGL layer only after an opaque, full-screen cover has loaded. */
export const useBackdropCover = (imageUrl: string): void => {
  useEffect(() => {
    const token = Symbol();
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active) return;
      covers.add(token);
      notify();
    };
    image.src = imageUrl;
    return () => {
      active = false;
      image.onload = null;
      if (covers.delete(token)) notify();
    };
  }, [imageUrl]);
};
