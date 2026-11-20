import { createContext } from 'react';

/** Registers the route's portal target without loading the karaoke screen at startup. */
export const KaraokeSlotContext = createContext<
  (slot: HTMLElement | null) => void
>(() => undefined);
