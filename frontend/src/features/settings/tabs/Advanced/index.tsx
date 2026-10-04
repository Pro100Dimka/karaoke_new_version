import { useText } from "../../../../i18n/useText";
import { AboutPanel } from "./About";
import { DiagnosticsPanel } from "./Diagnostics";
import { HistoryPanel } from "./History";
import { StoragePanel } from "./Storage";
import { useSubsystemHealth } from "./useSubsystemHealth";
import "./advanced.css";

export const AdvancedSettings = () => {
  const t = useText();
  const health = useSubsystemHealth();

  return (
    <section className="advancedGrid" aria-label={t("advanced")}>
      <StoragePanel usage={health.backend?.storage ?? null} onChanged={health.refresh} />
      <HistoryPanel />
      <DiagnosticsPanel health={health} />
      <AboutPanel health={health} />
    </section>
  );
};
