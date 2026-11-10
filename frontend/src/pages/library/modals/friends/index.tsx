import {
  Badge,
  Dialog,
  Stack,
  StatTile,
  Tabs,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { store } from '../../../../providers/store';
import { FriendsList } from './friends-tab';
import { RoomHistory } from './history';
import { FriendRequests } from './requests';

export const FriendsDialog = observer(() => {
  useLocale();
  const state = store.inbox;
  const inbox = state.type === 'inbox' ? state : undefined;
  const [open, setOpen] = useState(false);
  const friends = inbox?.friends ?? [];
  const online = friends.filter(
    (friend) => friend.presence !== 'Offline',
  ).length;
  const waiting = inbox?.friendRequests.length ?? 0;
  const [tab, setTab] = useState('friends');
  const tabs = [
    {
      value: 'friends',
      label: tr('friends'),
      icon: 'users',
      content: inbox && <FriendsList inbox={inbox} />,
    },
    {
      value: 'requests',
      label: (
        <>
          {tr('friendsTabRequests')}&nbsp;
          <Badge size="sm">{inbox?.friendRequests.length ?? 0}</Badge>
        </>
      ),
      icon: 'person',
      content: inbox && <FriendRequests inbox={inbox} />,
    },
    {
      value: 'history',
      label: tr('friendsTabHistory'),
      icon: 'history',
      content: <RoomHistory />,
    },
  ];
  return (
    <>
      <StatTile
        icon="users"
        tilt={false}
        value={friends.length}
        label={tr('social.friendsStat', { online })}
        aria-haspopup="dialog"
        badge={waiting > 0 ? waiting : undefined}
        badgeLabel={tr('incomingRequests')}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) setOpen(false);
        }}
        width="wide"
        icon="users"
        title={tr('friends')}
        description={tr('friendsIntro')}
        closeLabel={tr('closeDialog')}
        cancelLabel={false}
        confirmLabel={false}
      >
        {!inbox ? (
          <Typography tone="muted" text={tr('socialOffline')} />
        ) : (
          <Stack gap={3}>
            <Tabs
              value={tab}
              onValueChange={setTab}
              label={tr('friends')}
              items={tabs}
            />
            {tabs.find(({ value }) => value === tab)?.content}
          </Stack>
        )}
      </Dialog>
    </>
  );
});
