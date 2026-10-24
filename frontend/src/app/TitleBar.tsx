import { IconButton } from "@neo-ui-kit/react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageKey } from "../i18n/messages";
import { useText } from "../i18n/useText";
import { desktopClient } from "../services/desktopClient";
import { useWindowState } from "./useWindowState";

const windowActions = [
  {
    id: "minimize",
    label: "minimize",
    icon: "minus",
    run: () => void desktopClient.minimize(),
  },
  {
    // True full screen over the taskbar, like F11 in a browser; a plain maximize kept the taskbar.
    id: "fullscreen",
    label: "fullscreen",
    icon: "fit",
    run: () => void desktopClient.toggleFullscreen(),
  },
  {
    id: "close",
    label: "closeWindow",
    icon: "close",
    run: () => void desktopClient.close(),
  },
] as const satisfies readonly {
  id: string;
  label: MessageKey;
  icon: string;
  run(): void;
}[];

/** Screens put their own buttons on the title-bar row through this slot; it is a no-drag area so they stay clickable. */
export const titleBarLeadingId = "titleBarLeading";

const useTopModal = () => {
  const [modal, setModal] = useState<HTMLDialogElement | null>(null);
  useLayoutEffect(() => {
    if (typeof HTMLDialogElement.prototype.showModal !== "function") return;
    let stack: HTMLDialogElement[] = [];
    const update = (records: MutationRecord[] = []) => {
      // Attribute records preserve opening order even when it differs from DOM order.
      for (const { target, attributeName } of records) {
        if (!(target instanceof HTMLDialogElement) || attributeName !== "open") continue;
        stack = stack.filter((dialog) => dialog !== target);
        if (target.matches(":modal")) stack.push(target);
      }
      stack = stack.filter((dialog) => dialog.isConnected && dialog.matches(":modal"));
      for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog:modal"))
        if (!stack.includes(dialog)) stack.push(dialog);
      setModal(stack.at(-1) ?? null);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["open"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return modal;
};

export const TitleBar = () => {
  const t = useText();
  const { fullscreen } = useWindowState();
  const [moving, setMoving] = useState(false);
  const grab = useRef<{ x: number; y: number; ratio: number; offsetY: number; moving: boolean } | null>(null);
  const finishDrag = () => {
    if (grab.current?.moving) void desktopClient.dragWindow("end");
    grab.current = null;
    setMoving(false);
  };
  const modal = useTopModal();
  const controlsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = controlsRef.current;
    if (!modal || !element) return;
    // A dialog descendant escapes modal inertness; the popover top layer escapes
    // the kit dialog's overflow clipping and animated containing block.
    element.showPopover();
    return () => {
      if (element.isConnected && element.matches(":popover-open")) element.hidePopover();
    };
  }, [modal]);

  const controls = (
    <div
      ref={controlsRef}
      popover={modal ? "manual" : undefined}
      className="titleBarControls"
      data-fullscreen={fullscreen || moving || undefined}
      role="toolbar"
      aria-label={t("windowControls")}
    >
      {windowActions.map(({ id, label, icon, run }) => (
        <IconButton
          key={id}
          className={
            id === "close" ? "windowButton closeButton" : "windowButton"
          }
          variant="ghost"
          icon={icon}
          label={t(id === "fullscreen" && fullscreen ? "exitFullscreen" : label)}
          onClick={run}
        />
      ))}
    </div>
  );
  return (
    <header
      className={fullscreen || moving ? "titleBar titleBarFullscreen" : "titleBar"}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest("button")) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        grab.current = { x: event.screenX, y: event.screenY, ratio: event.clientX / window.innerWidth,
          offsetY: Math.min(80, Math.max(0, event.clientY)), moving: false };
      }}
      onPointerMove={(event) => {
        const anchor = grab.current;
        if (!anchor) return;
        if (!anchor.moving) {
          if (Math.hypot(event.screenX - anchor.x, event.screenY - anchor.y) < 5) return;
          anchor.moving = true;
          setMoving(true);
          void desktopClient.dragWindow("start", anchor.ratio, anchor.offsetY, event.screenX, event.screenY);
        } else void desktopClient.dragWindow("move", undefined, undefined, event.screenX, event.screenY);
      }}
      onDoubleClick={(event) => {
        if (!(event.target as Element).closest("button")) void desktopClient.toggleMaximize();
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
    >
      <div id={titleBarLeadingId} className="titleBarLeading" />
      {modal ? createPortal(controls, modal) : controls}
    </header>
  );
};
