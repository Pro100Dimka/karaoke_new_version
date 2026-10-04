import { useCallback, useState } from "react";
import { panelControls, type PanelLayout } from "@ad-voice/ui";
import { isRecord, readJson, storageKey, writeJson } from "../storage/localStore";

export { useFloatingPanel, type PanelLayout, type ResizeEdge, type ScreenPoint } from "@ad-voice/ui";

/** Controls keep their own gestures inside floating and detached panels. */
export const controlSelector = panelControls;

const layoutKey = (id: string) => storageKey(`panelLayout.${id}`);

const storedLayout = (id: string): PanelLayout | null => {
  const saved = readJson(layoutKey(id));
  if (!isRecord(saved)) return null;
  const { left, top, width, height } = saved;
  return [left, top, width, height].every(value => typeof value === "number" && Number.isFinite(value))
    ? { left, top, width, height } as PanelLayout
    : null;
};

/** A floating panel's placement kept in this computer's storage, for panels without a preference of their own. */
export const useStoredPanelLayout = (id: string) => {
  const [layout, setLayout] = useState(() => storedLayout(id));
  const save = useCallback((next: PanelLayout) => {
    writeJson(layoutKey(id), next);
    setLayout(next);
  }, [id]);
  return { layout, save };
};
