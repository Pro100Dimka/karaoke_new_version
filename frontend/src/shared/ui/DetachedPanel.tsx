import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton, tr, useLocale } from '@neo-ui-kit/react';
import type { useDetachedPanel } from './useDetachedPanel';
import { isRecord } from '../storage/localStore';
import './detached-panel.css';

type DetachedPanelState = ReturnType<typeof useDetachedPanel>;

/** Renders a panel in its own window while it is detached, and in place otherwise. */
export const DetachedPanel = ({
  panel,
  children,
  keepMounted = false,
  modal,
}: {
  panel: DetachedPanelState;
  children: ReactNode;
  keepMounted?: boolean;
  modal?: HTMLDialogElement | null;
}) => {
  const [content] = useState(() =>
    keepMounted ? document.createElement('div') : null,
  );
  const homeRef = useRef<HTMLDivElement | null>(null);
  const home = useCallback(
    (element: HTMLDivElement | null) => {
      homeRef.current = element;
      if (
        element &&
        content &&
        !panel.container &&
        !modal &&
        content.parentNode !== element
      )
        element.append(content);
    },
    [content, panel.container, modal],
  );
  useLayoutEffect(() => {
    if (!content) return;
    if (panel.container) panel.container.append(content);
    for (const canvas of content.querySelectorAll('canvas')) {
      if (!canvas.width || !canvas.height) continue;
      let context: CanvasRenderingContext2D | null;
      try {
        context = canvas.getContext('2d');
      } catch (error) {
        // Transferred canvases keep their renderer when the panel moves between documents.
        if (isRecord(error) && error.name === 'InvalidStateError') continue;
        throw error;
      }
      if (!context) continue;
      context.save();
      context.resetTransform();
      context.globalCompositeOperation = 'copy';
      context.drawImage(canvas, 0, 0);
      context.restore();
    }
  }, [content, panel.container]);
  useLayoutEffect(() => {
    if (!content || !modal || panel.container) return;
    modal.append(content);
    content.classList.add('detachedPanelOverlay');
    content.setAttribute('popover', 'manual');
    content.showPopover();
    return () => {
      if (content.matches(':popover-open')) content.hidePopover();
      content.removeAttribute('popover');
      content.classList.remove('detachedPanelOverlay');
      homeRef.current?.appendChild(content);
    };
  }, [content, modal, panel.container]);
  return content ? (
    <>
      <div ref={home} />
      {createPortal(children, content)}
    </>
  ) : panel.container ? (
    createPortal(children, panel.container)
  ) : (
    <>{children}</>
  );
};

/**
 * Brings a panel that was dragged out into a window of its own back into the app. Panels leave the
 * app by being dragged past the window's edge, so inside the app there is nothing to press.
 */
export const DetachButton = ({
  panel,
  size = 'sm',
}: {
  panel: DetachedPanelState;
  size?: 'xs' | 'sm';
}) => {
  useLocale();
  if (!panel.detached) return null;
  return (
    <IconButton
      size={size}
      icon="window"
      label={tr('panelAttach')}
      onClick={panel.attach}
    />
  );
};
