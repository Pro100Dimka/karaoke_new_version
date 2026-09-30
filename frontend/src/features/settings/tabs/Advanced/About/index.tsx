import { Info } from "lucide-react";
import { version } from "../../../../../../package.json";
import { useText } from "../../../../../i18n/useText";
import { SettingsCard } from "../../../SettingsCard";
import type { SubsystemHealth } from "../useSubsystemHealth";
import { SettingsPlanet, SettingsWaves } from "../Artwork";

export const frontendVersion: string = version;

export const AboutPanel = ({ health }: { health: SubsystemHealth }) => {
  const t = useText();
  const { backend, audioVersion } = health;
  const rows = [
    [t("frontendVersion"), frontendVersion],
    [
      t("pythonBackendVersion"),
      backend
        ? `${backend.backendVersion} (API ${backend.apiVersion})`
        : t("unavailable"),
    ],
    [t("audioServiceVersion"), audioVersion || t("unavailable")],
    [
      t("pipelineVersion"),
      backend
        ? `DB ${backend.dbSchema} · project format ${backend.projectFormat}`
        : t("unavailable"),
    ],
  ] as const;

  return (
    <SettingsCard className="advancedAboutCard" frameOrder={4} icon={Info} title="A&D Voice" description={t("copyright")}>
      <div className="aboutArt" aria-hidden="true"><SettingsWaves kind="about" /><SettingsPlanet /></div>
      <dl className="usageList">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="brandPromise">BETTER SOUND<br />BETTER SINGING</p>
      <span className="brandWave" aria-hidden="true">
        {[8, 19, 30, 40, 27, 17, 7].map((height, index) => <i key={`${height}-${index}`} style={{ height, animationDelay: `${-.2 - index * .2}s` }} />)}
      </span>
    </SettingsCard>
  );
};
