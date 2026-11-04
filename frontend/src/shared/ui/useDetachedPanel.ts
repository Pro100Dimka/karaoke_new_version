import { reportOperationFailure, clearOperationFailure } from '../errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  isRecord,
  readJson,
  storageKey,
  writeJson,
} from '../storage/localStore';
import {
  carryWindow,
  fitWindowToPanel,
  moveWindowBySurface,
  pointInApp,
} from './detachedWindow';
import { keyBelongsToControl } from './keyOwnership';
import { desktopClient } from '../../services/desktopClient';
import type { PanelLayout, ScreenPoint } from './useFloatingPanel';

/** Must match electron/PanelWindows.ts: only windows with this name may open. */
const panelWindowPrefix = 'ad-voice-panel:';

interface PanelSize {
  width: number;
  height: number;
}

interface PanelBounds extends PanelSize {
  left?: number;
  top?: number;
}

const boundsKey = (id: string) => storageKey(`panelWindow.${id}`);

const savedBounds = (id: string, fallback: PanelSize): PanelBounds => {
  const saved = readJson(boundsKey(id));
  if (!isRecord(saved)) return fallback;
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    width: number(saved.width) ?? fallback.width,
    height: number(saved.height) ?? fallback.height,
    left: number(saved.left),
    top: number(saved.top),
  };
};

const features = ({ width, height, left, top }: PanelBounds): string =>
  [
    `width=${Math.round(width)}`,
    `height=${Math.round(height)}`,
    ...(left === undefined ? [] : [`left=${Math.round(left)}`]),
    ...(top === undefined ? [] : [`top=${Math.round(top)}`]),
  ].join(',');

/**
 * The panel window shows the app's own styles and theme: every stylesheet (including ones loaded
 * later with a page), the base address their fonts resolve against, and the root attributes that
 * carry the theme. A screen can also mirror the app's theme scope, including its selected fonts.
 * Returns the cleanup that stops mirroring.
 */
export const mirrorAppearance = (
  source: Document,
  target: Document,
  scope?: HTMLElement,
): (() => void) => {
  const base = target.createElement('base');
  base.href = source.baseURI;
  target.head.append(base);
  const copy = (node: Node) => {
    if (
      node instanceof HTMLStyleElement ||
      (node instanceof HTMLLinkElement && node.rel === 'stylesheet')
    )
      target.head.append(node.cloneNode(true));
  };
  for (const node of source.head.childNodes) copy(node);
  const theme = scope && source.querySelector('.main-theme');
  const scopeClass = scope?.className;
  const copyRoot = () => {
    for (const { name, value } of [...source.documentElement.attributes])
      target.documentElement.setAttribute(name, value);
    target.body.className = source.body.className;
    if (theme && scope)
      for (const { name, value } of theme.attributes)
        scope.setAttribute(
          name,
          name === 'class' ? `${scopeClass} ${value}` : value,
        );
  };
  copyRoot();
  const styles = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) copy(node);
  });
  styles.observe(source.head, { childList: true });
  const root = new MutationObserver(copyRoot);
  root.observe(source.documentElement, { attributes: true });
  root.observe(source.body, { attributes: true, attributeFilter: ['class'] });
  if (theme) root.observe(theme, { attributes: true });
  return () => {
    styles.disconnect();
    root.disconnect();
  };
};

/**
 * Moves a panel of the app into a window of its own that can be dragged anywhere, even onto
 * another screen, and back. The window is drawn by this app (a portal into `container`), so the
 * panel keeps all of its state, controls and audio. It remembers where it was put; closing the
 * window, dropping it onto the app's window, or the panel leaving the app (e.g. karaoke ends)
 * brings it back; a drop places it where it was dropped (`onReturn`).
 */
export const useDetachedPanel = (
  id: string,
  title: string,
  size: PanelSize,
  onReturn?: (layout: PanelLayout) => void,
  enabled = true,
) => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const opened = useRef<Window | null>(null);
  const heldPointer = useRef<PointerEvent | null>(null);
  const returned = useRef(onReturn);
  returned.current = onReturn;
  const continuous = ['karaokeConsole', 'room'].includes(id);

  const returnToApp = useCallback(
    (layout?: PanelLayout) => {
      const panel = opened.current;
      opened.current = null;
      const restore = () => {
        if (layout) returned.current?.(layout);
        setContainer(null);
      };
      if (continuous) flushSync(restore);
      else restore();
      panel?.close();
    },
    [continuous],
  );
  const attach = useCallback(() => returnToApp(), [returnToApp]);

  /**
   * Opens the panel's window where it was last left, or at `at` (screen pixels) when torn off; a
   * torn-off panel still held by `pointer` follows it until released.
   */
  const detach = useCallback(
    (at?: PanelBounds, pointer?: ScreenPoint) => {
      if (opened.current && !opened.current.closed)
        return opened.current.focus();
      const bounds = at ?? savedBounds(id, size);
      const panel = window.open(
        'about:blank',
        `${panelWindowPrefix}${id}`,
        features(bounds),
      );
      if (!panel) return;
      panel.document.title = title;
      const stopMirroring = mirrorAppearance(document, panel.document);
      // An attribute, not a class: the app's root attributes mirrored onto this window replace its class.
      panel.document.documentElement.setAttribute('data-panel-window', '');
      const mount = panel.document.createElement('div');
      mount.className = 'detachedPanel';
      const appearance = document.querySelector<HTMLElement>('.main-theme');
      if (continuous && appearance) {
        const theme = getComputedStyle(appearance);
        panel.document.documentElement.style.fontSize = getComputedStyle(
          document.documentElement,
        ).fontSize;
        mount.style.cssText = appearance.style.cssText;
        mount.style.fontFamily = theme.fontFamily;
        for (const name of [
          '--ad-font-family-heading',
          '--ad-font-family-sans',
        ])
          mount.style.setProperty(name, theme.getPropertyValue(name));
      }
      // The panel keeps the width (and, for panels sized by their frame, the height) it had in the app.
      mount.style.setProperty(
        '--detached-panel-width',
        `${Math.round(bounds.width)}px`,
      );
      mount.style.setProperty(
        '--detached-panel-height',
        `${Math.round(bounds.height)}px`,
      );
      panel.document.body.append(mount);
      const setBounds = continuous ? desktopClient.setPanelBounds : undefined;
      const movePanel = setBounds
        ? (x: number, y: number) => {
            void setBounds(id, { x, y });
          }
        : undefined;
      const resizePanel = setBounds
        ? (width: number, height: number) => {
            void setBounds(id, { width, height });
          }
        : undefined;
      const stopFitting = fitWindowToPanel(panel, mount, resizePanel);
      const dropInApp = (layout: PanelLayout, pointer?: PointerEvent) => {
        heldPointer.current = pointer ?? null;
        returnToApp(layout);
      };
      if (movePanel && bounds.left !== undefined && bounds.top !== undefined)
        movePanel(bounds.left, bounds.top);
      const stopMoving = moveWindowBySurface(
        panel,
        mount,
        dropInApp,
        movePanel,
        continuous,
      );
      if (pointer && at?.left !== undefined && at.top !== undefined)
        carryWindow(
          panel,
          { left: at.left, top: at.top, width: at.width, height: at.height },
          pointer,
          continuous ? dropInApp : undefined,
          movePanel,
        );
      // Shortcuts belong to the app: keys pressed in the panel's window reach the app's window too.
      panel.addEventListener('keydown', (event) => {
        if (keyBelongsToControl(event.target, event.key)) return;
        const forwarded = new KeyboardEvent('keydown', {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          cancelable: true,
        });
        if (!window.dispatchEvent(forwarded)) event.preventDefault();
      });
      panel.addEventListener('pagehide', () => {
        writeJson(boundsKey(id), {
          width: panel.innerWidth,
          height: panel.innerHeight,
          left: panel.screenX,
          top: panel.screenY,
        });
        stopMirroring();
        stopFitting();
        stopMoving();
        if (opened.current === panel) {
          opened.current = null;
          setContainer(null);
        }
      });
      opened.current = panel;
      if (continuous) {
        const styles = [
          ...panel.document.querySelectorAll<HTMLLinkElement>(
            'link[rel="stylesheet"]',
          ),
        ];
        void Promise.all(
          styles.map((link) =>
            link.sheet
              ? undefined
              : new Promise<void>((resolve, reject) => {
                  link.addEventListener('load', () => resolve(), {
                    once: true,
                  });
                  link.addEventListener(
                    'error',
                    () =>
                      reject(
                        new Error(
                          `Unable to load panel stylesheet: ${link.href}`,
                        ),
                      ),
                    { once: true },
                  );
                }),
          ),
        )
          .then(() => {
            if (!panel.closed && opened.current === panel) {
              clearOperationFailure('errors.detachedPanel');
              flushSync(() => setContainer(mount));
            }
          })
          .catch((error: unknown) => {
            if (!panel.closed && opened.current === panel)
              reportOperationFailure('errors.detachedPanel', error);
            panel.close();
          });
      } else setContainer(mount);
    },
    [continuous, id, returnToApp, size, title],
  );

  useEffect(() => () => opened.current?.close(), []);
  useEffect(() => {
    if (enabled) return;
    heldPointer.current = null;
    opened.current?.close();
  }, [enabled]);

  const resumeDrag = (frame: HTMLElement | null) => {
    const pointer = heldPointer.current;
    if (!frame || !pointer) return;
    heldPointer.current = null;
    const point = pointInApp(pointer.screenX, pointer.screenY);
    if (!point) return;
    frame.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        pointerId: pointer.pointerId,
        clientX: point.x,
        clientY: point.y,
        screenX: pointer.screenX,
        screenY: pointer.screenY,
      }),
    );
  };

  return {
    container,
    detached: container !== null,
    detach,
    attach,
    heldPointer,
    resumeDrag,
  };
};
