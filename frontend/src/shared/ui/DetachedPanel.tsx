import { ExternalLink, PanelTopClose } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useText } from "../../i18n/useText";
import { IconButton } from "../../theme/ui";
import type { useDetachedPanel } from "./useDetachedPanel";
import "./detached-panel.css";

type DetachedPanelState = ReturnType<typeof useDetachedPanel>;

/** Renders a panel in its own window while it is detached, and in place otherwise. */
export const DetachedPanel = ({ panel, children }: { panel: DetachedPanelState; children: ReactNode }) =>
  panel.container ? createPortal(children, panel.container) : <>{children}</>;

/** Moves the panel into its own window, or back into the app. */
export const DetachButton = ({ panel, size = "sm" }: { panel: DetachedPanelState; size?: "xs" | "sm" }) => {
  const t = useText();
  return (
    <IconButton
      size={size}
      variant="outline"
      icon={panel.detached ? PanelTopClose : ExternalLink}
      label={t(panel.detached ? "panelAttach" : "panelDetach")}
      onClick={panel.detached ? panel.attach : panel.detach}
    />
  );
};
