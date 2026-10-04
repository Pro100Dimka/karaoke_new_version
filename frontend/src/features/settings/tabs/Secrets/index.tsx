import { ProgressBar } from "@ad-voice/ui";
import { useText } from "../../../../i18n/useText";
import { EnvironmentGroupCard } from "./EnvironmentGroupCard";
import { EnvironmentJson } from "./EnvironmentJson";
import { groupEntries, type EnvironmentGroup } from "./secretsModel";
import "./secrets.css";
import { useEnvironmentSettings } from "./useEnvironmentSettings";

/** Kaggle and the room server share the first row; the wider groups follow full width. */
const rows: readonly (readonly EnvironmentGroup[])[] = [["kaggle", "room"], ["recognition"], ["deployment"]];

export const SecretsSettings = () => {
  const t = useText();
  const environment = useEnvironmentSettings();
  const { entries } = environment;
  if (!entries) return <ProgressBar indeterminate label={t("loadingSettings")} />;

  const card = (group: EnvironmentGroup) => (
    <EnvironmentGroupCard key={group} group={group} entries={groupEntries(entries, group)} kaggle={environment.kaggle}
      onChange={environment.change} onPick={(key, path) => void environment.save(key, path)} />
  );
  const visible = rows
    .map(row => row.filter(group => groupEntries(entries, group).length > 0))
    .filter(row => row.length > 0);

  return (
    <section aria-label={t("environmentKeys")} className="environmentForm settingsStack">
      {visible.map(row => (
        <div key={row.join("-")} className="environmentRow" data-columns={row.length}>{row.map(card)}</div>
      ))}
      <EnvironmentJson values={environment.json} onApply={environment.applyJson} />
    </section>
  );
};
