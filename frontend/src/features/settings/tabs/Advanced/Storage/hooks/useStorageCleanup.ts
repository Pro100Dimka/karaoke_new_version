import { useRef, useState } from "react";
import { useAsk } from "../../../../../../app/DialogProvider";
import { useNotify } from "../../../../../../app/NotificationsProvider";
import { useText } from "../../../../../../i18n/useText";
import { useSettingsBackend } from "../../../../../../app/SettingsProvider";

type CleanupKind = "cache" | "temp";

/** Confirmation and cleanup share one lock, including while a dialog is pending. */
export const useStorageCleanup = (onChanged: () => void) => {
  const backend = useSettingsBackend();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const [cleaning, setCleaning] = useState<CleanupKind | null>(null);
  const inFlight = useRef(false);

  const clean = async (kind: CleanupKind) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCleaning(kind);
    try {
      const choice = await ask({
        title: t(kind === "cache" ? "clearCache" : "removeTemporaryFiles"),
        body: t("cleanupBody"),
        actions: [
          { id: "cancel", label: t("cancel") },
          { id: "confirm", label: t("confirm"), appearance: "primary" },
        ],
      });
      if (choice !== "confirm") return;
      await (kind === "cache"
        ? backend.clearCache()
        : backend.clearTemporaryFiles());
      notify(t("cleanupDone"), "success");
      onChanged();
    } catch {
      notify(t("cleanupFailed"), "error");
    } finally {
      inFlight.current = false;
      setCleaning(null);
    }
  };

  return { cleaning, clean };
};
