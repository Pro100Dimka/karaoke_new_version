import {
  Badge,
  Button,
  Card,
  NeonWaves,
  ProgressBar,
  ServerArt,
  Spectrum,
  Stack,
  Typography,
} from "@ad-voice/ui";
import { useText } from "../../../../i18n/useText";
import { EnvironmentField } from "./EnvironmentField";
import {
  formatElapsed,
  groupState,
  groupUi,
  type DisplayEntry,
  type EnvironmentGroup,
} from "./secretsModel";
import type { useKaggleActions } from "./useKaggleActions";

const kaggleActions = [
  { action: "login", icon: "login", label: "kaggleLogin", variant: undefined },
  { action: "deploy", icon: "rocket", label: "kaggleDeploy", variant: "primary" },
] as const;

/** The picture in each group's header; the cards keep the scenes they had before. */
const GroupArt = ({ group }: { group: EnvironmentGroup }) => {
  if (group === "kaggle")
    return (
      <>
        <NeonWaves strands={16} phase={0} stars={false} />
        <Badge tone="info">GPU</Badge>
      </>
    );
  if (group === "recognition")
    return (
      <>
        <NeonWaves strands={20} phase={1.64} stars={false} />
        <Spectrum variant="bars" />
      </>
    );
  return (
    <>
      <NeonWaves strands={16} phase={group === "room" ? 0.82 : 2.46} stars={false} />
      <ServerArt upload={group === "deployment"} />
    </>
  );
};

/** Kaggle deployment progress, or the sign-in and deploy actions while the notebook is not ready. */
const KaggleControls = ({
  kaggle,
  ready,
}: {
  kaggle: ReturnType<typeof useKaggleActions>;
  ready: boolean;
}) => {
  const t = useText();
  const { kaggleAction, kaggleElapsedSeconds, runKaggleAction } = kaggle;
  return (
    <>
      {kaggleAction === "deploy" && (
        <Stack gap={1} role="status">
          <ProgressBar
            indeterminate
            label={t("kaggleDeployProgressLabel")}
            aria-valuetext={t("kaggleDeployProgressTitle")}
          />
          <Typography as="strong" variant="body-sm">
            {t("kaggleDeployProgressTitle")}
          </Typography>
          <Typography variant="caption" tone="muted">
            {t("kaggleDeployProgressTiming", {
              elapsed: formatElapsed(kaggleElapsedSeconds),
            })}
          </Typography>
        </Stack>
      )}
      {!ready && (
        <Stack direction="row" gap={3} wrap>
          {kaggleActions.map(({ action, icon, label, variant }) => (
            <Button
              key={action}
              size="sm"
              variant={variant}
              icon={icon}
              loading={kaggleAction === action}
              disabled={kaggleAction !== null}
              onClick={() => void runKaggleAction(action)}
            >
              {t(label)}
            </Button>
          ))}
        </Stack>
      )}
    </>
  );
};

/** One ENV group: its scene, its fields, and for Kaggle the notebook controls. */
export const EnvironmentGroupCard = ({
  group,
  entries,
  kaggle,
  onChange,
  onSave,
}: {
  group: EnvironmentGroup;
  entries: readonly DisplayEntry[];
  kaggle: ReturnType<typeof useKaggleActions>;
  onChange(key: string, value: string): void;
  onSave(key: string, value: string): void;
}) => {
  const t = useText();
  const ui = groupUi[group];
  const state = groupState(entries);

  return (
    <Card
      border
      className="environmentGroupCard"
      data-group={group}
      data-state={state}
      icon={ui.icon}
      title={t(ui.title)}
      description={t(ui.hint)}
      actions={
        <span className="environmentGroupArt" aria-hidden="true">
          <GroupArt group={group} />
        </span>
      }
    >
      <div className="settingsStack">
        <div className="environmentFields">
          {entries.map((entry) => (
            <EnvironmentField
              key={entry.key}
              entry={entry}
              onChange={(value) => onChange(entry.key, value)}
              onSave={(value) => onSave(entry.key, value)}
            />
          ))}
        </div>
        {group === "kaggle" && (
          <KaggleControls
            kaggle={kaggle}
            ready={state === "valid" || state === "checking"}
          />
        )}
      </div>
    </Card>
  );
};
