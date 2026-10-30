import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import {
  panelControls,
  useFloatingPanel as useKitFloatingPanel,
  type FloatingPanelOptions,
  type PanelLayout,
} from "@neo-ui-kit/react";
import {
  isRecord,
  readJson,
  storageKey,
  writeJson,
} from "../storage/localStore";

export { type PanelLayout, type ScreenPoint } from "@neo-ui-kit/react";

// A switch or checkbox is a <label> around its input: pressing its visible track hits the label, not the input,
// and the kit's list of controls does not name labels, so the panel took the press for a drag and the switch never
// toggled (the room's monitoring switch).
const labelledControls = "label";

/** Controls keep their own gestures inside floating and detached panels. */
export const controlSelector = `${panelControls}, ${labelledControls}`;

/** Drag bounds follow the rendered panel, including a participant joining or a section expanding. */
export const useMeasuredPanelSize = (
  ref: RefObject<HTMLElement | null>, fallback: { width: number; height: number }, mounted = true,
  space: "screen" | "layout" = "screen",
) => {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!mounted || !element) return;
    const measure = () => {
      const { width, height } = space === "layout"
        ? { width: element.offsetWidth, height: element.offsetHeight }
        : element.getBoundingClientRect();
      if (width > 0 && height > 0) setSize((current) =>
        current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mounted, space]);
  return size;
};

/** The kit's floating panel, with labelled controls (switches, checkboxes) also keeping their own presses. */
export const useFloatingPanel = (
  frameRef: RefObject<HTMLElement | null>,
  options: FloatingPanelOptions = {},
) =>
  useKitFloatingPanel(frameRef, {
    ...options,
    ignore: options.ignore
      ? `${labelledControls}, ${options.ignore}`
      : labelledControls,
  });

const layoutKey = (id: string) => storageKey(`panelLayout.${id}`);

const storedLayout = (id: string): PanelLayout | null => {
  const saved = readJson(layoutKey(id));
  if (!isRecord(saved)) return null;
  const { left, top, width, height } = saved;
  return [left, top, width, height].every(
    (value) => typeof value === "number" && Number.isFinite(value),
  )
    ? ({ left, top, width, height } as PanelLayout)
    : null;
};

/** A floating panel's placement kept in this computer's storage, for panels without a preference of their own. */
export const useStoredPanelLayout = (id: string) => {
  const [layout, setLayout] = useState(() => storedLayout(id));
  const save = useCallback(
    (next: PanelLayout) => {
      writeJson(layoutKey(id), next);
      setLayout(next);
    },
    [id],
  );
  return { layout, save };
};
