import { Maximize2, Minus, X, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../i18n/messages";
import { useText } from "../i18n/useText";
import { IconButton } from "../theme/ui";
import { desktopClient } from "../services/desktopClient";
import { useWindowState } from "./useWindowState";

interface WindowAction {
  id: "minimize" | "maximize" | "close";
  label: MessageKey;
  icon: LucideIcon;
  className: string;
  iconSize: 16 | 17;
  run(): void;
}

const windowActions = [
  {
    id: "minimize",
    label: "minimize",
    icon: Minus,
    className: "windowButton",
    iconSize: 17,
    run: () => {
      void desktopClient.minimize();
    }
  },
  {
    id: "maximize",
    label: "maximizeRestore",
    icon: Maximize2,
    className: "windowButton",
    iconSize: 16,
    run: () => {
      void desktopClient.toggleMaximize();
    }
  },
  {
    id: "close",
    label: "closeWindow",
    icon: X,
    className: "windowButton closeButton",
    iconSize: 17,
    run: () => {
      void desktopClient.close();
    }
  }
] as const satisfies readonly WindowAction[];

export const TitleBar = () => {
  const t = useText();
  const { maximized, fullscreen } = useWindowState();

  return (
    <header className={fullscreen ? "titleBar titleBarFullscreen" : "titleBar"}>
      <div className="titleBarControls" role="toolbar" aria-label={t("windowControls")}>
        {windowActions.map(({ id, label, icon: Icon, className, iconSize, run }) => (
          <IconButton
            key={id}
            className={className}
            variant="ghost"
            tone={id === "close" ? "danger" : "neutral"}
            icon={Icon}
            iconSize={iconSize * 2}
            label={t(id === "maximize" && maximized ? "restoreWindow" : label)}
            onClick={run}
          />
        ))}
      </div>
    </header>
  );
};
