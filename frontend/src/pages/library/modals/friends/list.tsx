import { EmptyState, tr } from '@neo-ui-kit/react';
import type { ReactNode } from 'react';
import type { SocialPerson } from '../../../../contracts/social';
import { PersonRow } from '../../../../features/social/PersonRow';

export default function FriendsList({
  rows,
  actions,
  detail,
}: Readonly<{
  rows: readonly SocialPerson[];
  actions(friend: SocialPerson): ReactNode;
  detail?(friend: SocialPerson): string;
}>) {
  if (!rows.length)
    return (
      <EmptyState icon="users" title={tr('friendsEmpty')} description="" />
    );
  return (
    <ul className="personList">
      {rows.map((friend) => (
        <PersonRow
          key={friend.accountId}
          accountId={friend.accountId}
          avatarVersion={friend.avatarVersion}
          name={friend.displayName}
          presence={friend.presence}
          detail={detail?.(friend)}
          actions={actions(friend)}
        />
      ))}
    </ul>
  );
}
