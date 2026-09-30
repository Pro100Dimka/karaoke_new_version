import type { RefObject } from "react";
import { useApp } from "../../app/AppContext";
import { useFloatingPanel, type PanelLayout } from "../../shared/ui/useFloatingPanel";

export type { ResizeEdge } from "../../shared/ui/useFloatingPanel";

export const defaultPianoRollHeight = 180;
const defaultPianoRollWidth = 920;
const limits = { minWidth: 320, minHeight: 100, maxHeight: 480 };

/**
 * The piano roll as a floating panel: click to select, drag anywhere on screen, resize from every
 * edge or corner, drag past the window's edge to give it a window of its own. The chosen layout is
 * saved (frontend/src/shared/preferences) and reapplied on every future karaoke session.
 */
export const usePianoRollLayout = (
  frameRef: RefObject<HTMLDivElement | null>,
  onTearOff?: (screenBounds: PanelLayout) => void,
) => {
  const { preferences, updatePreferences } = useApp();
  return useFloatingPanel(frameRef, {
    layout: preferences.pianoRollLayout,
    save: pianoRollLayout => updatePreferences({ pianoRollLayout }),
    defaultSize: { width: defaultPianoRollWidth, height: defaultPianoRollHeight },
    limits,
    onTearOff,
  });
};
