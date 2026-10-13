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
    <header className={fullscreen ? "titleBar titleBarFullscreen" : "titleBar"}>
      <div id={titleBarLeadingId} className="titleBarLeading" />
      {modal ? createPortal(controls, modal) : controls}
    </header>
  );
};
