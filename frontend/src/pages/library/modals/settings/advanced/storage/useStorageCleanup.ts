import { tr, useLocale } from "@neo-ui-kit/react";
import { useRef, useState } from "react";
import { ask } from "../../../../../../providers/dialog";
import { useNotify } from "../../../../../../providers/notifications";
import { ru } from "../../../../../../i18n/messages.ru";
import { pythonClient as backend } from "../../../../../../services/pythonClient";

type CleanupKind = "cache" | "temp";

/** Confirmation and cleanup share one lock, including while a dialog is pending. */
export const useStorageCleanup = (onChanged: () => void) => {
  const notify = useNotify();
  useLocale();
  const [cleaning, setCleaning] = useState<CleanupKind | null>(null);
  const inFlight = useRef(false);

  const clean = async (kind: CleanupKind) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCleaning(kind);
    try {
      const choice = await ask({
        title: tr(ru[kind === "cache" ? "clearCache" : "removeTemporaryFiles"]),
        body: tr(ru.cleanupBody),
        actions: [
          { id: "cancel", label: tr(ru.cancel) },
          { id: "confirm", label: tr(ru.confirm), appearance: "primary" },
        ],
      });
      if (choice !== "confirm") return;
      await (kind === "cache"
        ? backend.clearCache()
        : backend.clearTemporaryFiles());
      notify(tr(ru.cleanupDone), "success");
      onChanged();
    } catch {
      notify(tr(ru.cleanupFailed), "error");
    } finally {
      inFlight.current = false;
      setCleaning(null);
    }
  };

  return { cleaning, clean };
};
