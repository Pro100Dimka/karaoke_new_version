import { Info } from "lucide-react";
import { useText } from "../../i18n/useText";
import { SettingsCard } from "./SettingsCard";
import type { SubsystemHealth } from "./useSubsystemHealth";
import { frontendVersion } from "./version";

export const AboutPanel = ({ health }: { health: SubsystemHealth }) => {
  const t = useText();
  const { backend, audioVersion } = health;
  const rows = [
    [t("frontendVersion"), frontendVersion],
    [t("pythonBackendVersion"), backend ? `${backend.backendVersion} (API ${backend.apiVersion})` : t("unavailable")],
    [t("audioServiceVersion"), audioVersion || t("unavailable")],
    [t("pipelineVersion"), backend ? `DB ${backend.dbSchema} · project format ${backend.projectFormat}` : t("unavailable")]
  ] as const;

  return (
    <SettingsCard icon={Info} title="A&D Voice" description={t("copyright")}>
      <dl className="usageList">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
};
