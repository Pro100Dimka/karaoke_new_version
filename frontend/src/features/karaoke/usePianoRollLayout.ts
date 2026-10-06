import type { RefObject } from "react";
import { useApp } from "../../app/AppContext";
import {
  useFloatingPanel,
  type PanelLayout,
  type ScreenPoint,
} from "../../shared/ui/useFloatingPanel";
const limits = { minWidth: 320, minHeight: 100, maxHeight: 480 };

/**
 * The piano roll as a floating panel: click to select, drag anywhere on screen, resize from every
 * edge or corner, drag past the window's edge to give it a window of its own. The chosen layout is
 * saved (frontend/src/shared/preferences) and reapplied on every future karaoke session.
 */
export const usePianoRollLayout = (
  frameRef: RefObject<HTMLDivElement | null>,
  onTearOff?: (screenBounds: PanelLayout, pointer: ScreenPoint) => void,
) => {
  const { preferences, updatePreferences } = useApp("preferences");
  return useFloatingPanel(frameRef, {
    layout: preferences.pianoRollLayout,
    onLayoutChange: (pianoRollLayout) => updatePreferences({ pianoRollLayout }),
    defaultSize: { width: 920, height: 180 },
    limits,
    onDragOutside: onTearOff,
  });
};
