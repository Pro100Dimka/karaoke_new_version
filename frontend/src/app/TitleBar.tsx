import { IconButton } from "@ad-voice/ui";
import type { MessageKey } from "../i18n/messages";
import { useText } from "../i18n/useText";
import { desktopClient } from "../services/desktopClient";
import { useWindowState } from "./useWindowState";

const windowActions = [
  { id: "minimize", label: "minimize", icon: "minus", run: () => void desktopClient.minimize() },
  { id: "maximize", label: "maximizeRestore", icon: "fit", run: () => void desktopClient.toggleMaximize() },
  { id: "close", label: "closeWindow", icon: "close", run: () => void desktopClient.close() },
] as const satisfies readonly { id: string; label: MessageKey; icon: string; run(): void }[];

/** Screens put their own buttons on the title-bar row through this slot; it is a no-drag area so they stay clickable. */
export const titleBarLeadingId = "titleBarLeading";

export const TitleBar = () => {
  const t = useText();
  const { maximized, fullscreen } = useWindowState();

  return (
    <header className={fullscreen ? "titleBar titleBarFullscreen" : "titleBar"}>
      <div id={titleBarLeadingId} className="titleBarLeading" />
      <div className="titleBarControls" role="toolbar" aria-label={t("windowControls")}>
        {windowActions.map(({ id, label, icon, run }) => (
          <IconButton key={id} className={id === "close" ? "windowButton closeButton" : "windowButton"} variant="ghost"
            icon={icon} label={t(id === "maximize" && maximized ? "restoreWindow" : label)} onClick={run} />
        ))}
      </div>
    </header>
  );
};
