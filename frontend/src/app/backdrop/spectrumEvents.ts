import type { SpectrumFrame } from "./useSpectrumFeed";

const frameEvent = "spectrum-frame";
const bus = new EventTarget();

/** The backdrop's spectrum poll is the only one; other visuals (song covers) listen here instead of polling again. */
export const publishSpectrum = (frame: SpectrumFrame): void => {
  bus.dispatchEvent(new CustomEvent<SpectrumFrame>(frameEvent, { detail: frame }));
};

export const subscribeSpectrum = (listener: (frame: SpectrumFrame) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<SpectrumFrame>).detail);
  bus.addEventListener(frameEvent, handler);
  return () => bus.removeEventListener(frameEvent, handler);
};
