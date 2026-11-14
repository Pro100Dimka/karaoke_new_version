import {
  Badge,
  Card,
  NeonWaves,
  ServerArt,
  Spectrum,
  Stack,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import {
  groupState,
  type DisplayEntry,
  type EnvironmentGroup,
} from './environmentModel';
import { EnvironmentField } from './EnvironmentField';
import { groupUi } from './environmentPresentation';

/** The picture in each group's header; the cards keep the scenes they had before. */
const GroupArt = ({ group }: { group: EnvironmentGroup }) => {
  const [phase, art] = (
    {
      processing: [0, <Badge tone="info">GPU</Badge>],
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

/** One ENV group with its connection fields. */
export const EnvironmentGroupCard = ({
  group,
  entries,
  onChange,
  onSave,
}: {
  group: EnvironmentGroup;
  entries: readonly DisplayEntry[];
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
      title={tr(ui.title)}
      description={tr(ui.hint)}
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
      </Stack>
    </Card>
  );
};
