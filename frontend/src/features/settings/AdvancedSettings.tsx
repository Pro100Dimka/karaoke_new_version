import { useId } from "react";
import { useText } from "../../i18n/useText";
import { AboutPanel } from "./AboutPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { StoragePanel } from "./StoragePanel";
import { useSubsystemHealth } from "./useSubsystemHealth";

export const AdvancedSettings = () => {
  const t = useText();
  const titleId = useId();
  const health = useSubsystemHealth();

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>{t("advanced")}</h2>
      <div className="diagnosticGrid">
        <StoragePanel usage={health.backend?.storage ?? null} onChanged={health.refresh} />
        <HistoryPanel />
        <DiagnosticsPanel health={health} />
        <AboutPanel health={health} />
      </div>
    </section>
  );
};
