import { EmptyState, Grid, Stack, Typography, tr } from '@neo-ui-kit/react';
import type { ReactNode } from 'react';
import type { SocialPerson } from '../../../../contracts/social';
import { PersonAvatar } from '../../../../features/social/PersonAvatar';

export default function FriendsList({ rows, actions, detail }: {
  rows: readonly SocialPerson[];
  actions(friend: SocialPerson): ReactNode;
  detail?(friend: SocialPerson): string;
}) {
  if (!rows.length) return <EmptyState icon="users" title={tr('friendsEmpty')} description="" />;
  return <Stack role="list" gap={3}>
    {rows.map((friend) => <Grid key={friend.accountId} role="listitem"
      columns="auto minmax(0, 1fr) auto" align="center" gap={3}>
      <PersonAvatar accountId={friend.accountId} avatarVersion={friend.avatarVersion}
        name={friend.displayName} presence={friend.presence} />
      <Stack>
        <Typography variant="h3" text={friend.displayName} />
        {detail && <Typography variant="caption" tone="muted" text={detail(friend)} />}
      </Stack>
      <Stack direction="row" justify="end" gap={1}>{actions(friend)}</Stack>
    </Grid>)}
  </Stack>;
}
