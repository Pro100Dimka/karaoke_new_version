import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useText } from "../../i18n/useText";
import { IconButton } from "@ad-voice/ui";
import type { useDetachedPanel } from "./useDetachedPanel";
import "./detached-panel.css";

type DetachedPanelState = ReturnType<typeof useDetachedPanel>;

/** Renders a panel in its own window while it is detached, and in place otherwise. */
export const DetachedPanel = ({ panel, children }: { panel: DetachedPanelState; children: ReactNode }) =>
  panel.container ? createPortal(children, panel.container) : <>{children}</>;

/**
 * Brings a panel that was dragged out into a window of its own back into the app. Panels leave the
 * app by being dragged past the window's edge, so inside the app there is nothing to press.
 */
export const DetachButton = ({ panel, size = "sm" }: { panel: DetachedPanelState; size?: "xs" | "sm" }) => {
  const t = useText();
  if (!panel.detached) return null;
  return (
    <IconButton size={size} icon="window" label={t("panelAttach")} onClick={panel.attach} />
  );
};
