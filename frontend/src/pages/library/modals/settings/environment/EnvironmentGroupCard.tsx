import { useEffect, useState } from 'react';
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
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { ru } from '../../../../../i18n/messages.ru';
import type { KaggleSettings } from './useEnvironmentSettings';
import {
  groupState,
  type DisplayEntry,
  type EnvironmentGroup,
} from './environmentModel';
import { EnvironmentField } from './EnvironmentField';
import { formatElapsed, groupUi } from './environmentPresentation';

const kaggleActions = [
  { action: 'login', icon: 'login', label: 'kaggleLogin', variant: undefined },
  {
    action: 'deploy',
    icon: 'rocket',
    label: 'kaggleDeploy',
    variant: 'primary',
  },
] as const;

/** The picture in each group's header; the cards keep the scenes they had before. */
const GroupArt = ({ group }: { group: EnvironmentGroup }) => {
  const [phase, art] = (
    {
      kaggle: [0, <Badge tone="info">GPU</Badge>],
      recognition: [1.64, <Spectrum variant="bars" />],
      room: [0.82, <ServerArt upload={false} />],
      deployment: [2.46, <ServerArt upload />],
    } as const
  )[group];
  return (
    <>
      <NeonWaves
        strands={group === 'recognition' ? 20 : 16}
        phase={phase}
        stars={false}
      />
      {art}
    </>
  );
};

const KaggleElapsed = ({ startedAt }: { startedAt: number | null }) => {
  useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const elapsed =
    startedAt === null
      ? 0
      : Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <Typography variant="caption" tone="muted">
      {tr(ru.kaggleDeployProgressTiming, { elapsed: formatElapsed(elapsed) })}
    </Typography>
  );
};

/** Kaggle deployment progress, or the sign-in and deploy actions while the notebook is not ready. */
const KaggleControls = ({
  kaggle,
  ready,
}: {
  kaggle: KaggleSettings;
  ready: boolean;
}) => {
  useLocale();
  const { kaggleAction, kaggleStartedAt, runKaggleAction } = kaggle;
  return (
    <>
      {kaggleAction === 'deploy' && (
        <Stack gap={1} role="status">
          <ProgressBar
            indeterminate
            label={tr(ru.kaggleDeployProgressLabel)}
            aria-valuetext={tr(ru.kaggleDeployProgressTitle)}
          />
          <Typography as="strong" variant="body-sm">
            {tr(ru.kaggleDeployProgressTitle)}
          </Typography>
          <KaggleElapsed startedAt={kaggleStartedAt} />
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
              label={tr(ru[label])}
            />
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
  kaggle: KaggleSettings;
  onChange(key: string, value: string): void;
  onSave(key: string, value: string): void;
}) => {
  useLocale();
  const ui = groupUi[group];
  const state = groupState(entries);

  return (
    <Card
      border
      className="environmentGroupCard"
      data-group={group}
      data-state={state}
      icon={ui.icon}
      title={tr(ru[ui.title])}
      description={tr(ru[ui.hint])}
      style={{ background: 'unset!important', boxShadow: 'unset!important' }}
      actions={
        <span className="environmentGroupArt" aria-hidden="true">
          <GroupArt group={group} />
        </span>
      }
    >
      <Stack gap={4}>
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
        {group === 'kaggle' && (
          <KaggleControls
            kaggle={kaggle}
            ready={['valid', 'checking'].includes(state)}
          />
        )}
      </Stack>
    </Card>
  );
};
