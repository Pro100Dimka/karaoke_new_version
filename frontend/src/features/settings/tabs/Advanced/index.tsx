import { useId } from "react";
import { useText } from "../../../../i18n/useText";
import { useSubsystemHealth } from "./useSubsystemHealth";
import { AboutPanel } from "./About";
import { DiagnosticsPanel } from "./Diagnostics";
import { HistoryPanel } from "./History";
import { StoragePanel } from "./Storage";
import "./advanced.css";

export const AdvancedSettings = () => {
  const t = useText();
  const titleId = useId();
  const health = useSubsystemHealth();

  return (
    <section className="advancedSettings" aria-labelledby={titleId}>
      <h2 className="ui-visually-hidden" id={titleId}>{t("advanced")}</h2>
      <div className="diagnosticGrid">
        <StoragePanel
          usage={health.backend?.storage ?? null}
          onChanged={health.refresh}
        />
        <HistoryPanel />
        <DiagnosticsPanel health={health} />
        <AboutPanel health={health} />
      </div>
    </section>
  );
};
