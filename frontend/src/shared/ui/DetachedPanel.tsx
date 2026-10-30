import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ru } from "../../i18n/messages.ru";
import { IconButton, tr, useLocale } from "@neo-ui-kit/react";
import type { useDetachedPanel } from "./useDetachedPanel";
import "./detached-panel.css";

type DetachedPanelState = ReturnType<typeof useDetachedPanel>;

/** Renders a panel in its own window while it is detached, and in place otherwise. */
export const DetachedPanel = ({
  panel,
  children,
  keepMounted = false,
}: {
  panel: DetachedPanelState;
  children: ReactNode;
  keepMounted?: boolean;
}) => {
  const [content] = useState(() => keepMounted ? document.createElement("div") : null);
  const home = useCallback((element: HTMLDivElement | null) => {
    if (element && content && !panel.container && content.parentNode !== element) element.append(content);
  }, [content, panel.container]);
  useLayoutEffect(() => {
    if (!content) return;
    if (panel.container) panel.container.append(content);
    for (const canvas of content.querySelectorAll("canvas")) {
      if (!canvas.width || !canvas.height) continue;
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.save();
      context.resetTransform();
      context.globalCompositeOperation = "copy";
      context.drawImage(canvas, 0, 0);
      context.restore();
    }
  }, [content, panel.container]);
  return content ? <><div ref={home} />{createPortal(children, content)}</>
    : panel.container ? createPortal(children, panel.container) : <>{children}</>;
};

/**
 * Brings a panel that was dragged out into a window of its own back into the app. Panels leave the
 * app by being dragged past the window's edge, so inside the app there is nothing to press.
 */
export const DetachButton = ({
  panel,
  size = "sm",
}: {
  panel: DetachedPanelState;
  size?: "xs" | "sm";
}) => {
  useLocale();
  if (!panel.detached) return null;
  return (
    <IconButton
      size={size}
      icon="window"
      label={tr(ru.panelAttach)}
      onClick={panel.attach}
    />
  );
};
