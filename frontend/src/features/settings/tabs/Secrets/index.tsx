import { Button, MessageBar, ProgressBar } from "@neo-ui-kit/react";
import { useText } from "../../../../i18n/useText";
import { EnvironmentGroupCard } from "./ui/EnvironmentGroupCard";
import { EnvironmentJson } from "./ui/EnvironmentJson";
import type { EnvironmentGroup } from "./model/environmentModel";
import { groupEntries } from "./ui/environmentPresentation";
import "./ui/secrets.css";
import { useEnvironmentSettings } from "./hooks/useEnvironmentSettings";

/** Kaggle and the room server share the first row; the wider groups follow full width. */
const userRows: readonly (readonly EnvironmentGroup[])[] = [
  ["kaggle", "room"],
  ["recognition"],
];
/**
 * Updating the Room Server over SSH and editing the raw environment JSON are developer tools: a
 * released app does not show a user where its maintainers' SSH keys live or let them hand-edit it.
 */
const developerTools = import.meta.env.DEV;
const rows = developerTools ? [...userRows, ["deployment"] as const] : userRows;

export const SecretsSettings = () => {
  const t = useText();
  const environment = useEnvironmentSettings();
  const { entries } = environment;
  if (environment.loadError)
    return (
      <MessageBar
        tone="error"
        action={
          <Button size="sm" onClick={environment.retry}>
            {t("retry")}
          </Button>
        }
      >
        {environment.loadError}
      </MessageBar>
    );
  if (!entries)
    return <ProgressBar indeterminate label={t("loadingSettings")} />;

  const card = (group: EnvironmentGroup) => (
    <EnvironmentGroupCard
      key={group}
      group={group}
      entries={groupEntries(entries, group)}
      kaggle={environment.kaggle}
      onChange={environment.change}
      onSave={(key, value) => void environment.save(key, value)}
    />
  );
  const visible = rows
    .map((row) =>
      row.filter((group) => groupEntries(entries, group).length > 0),
    )
    .filter((row) => row.length > 0);

  return (
    <section
      aria-label={t("environmentKeys")}
      className="environmentForm settingsStack"
    >
      {visible.map((row) => (
        <div
          key={row.join("-")}
          className="environmentRow"
          data-columns={row.length}
        >
          {row.map(card)}
        </div>
      ))}
      {developerTools && (
        <EnvironmentJson
          values={environment.json}
          onApply={environment.applyJson}
        />
      )}
    </section>
  );
};
