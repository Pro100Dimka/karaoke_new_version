import { observer } from "mobx-react-lite";
import { store } from "../../../../providers/store";
import { useState } from 'react';
import { Badge, Dialog, Stack, Tabs, Typography, tr, useLocale } from '@neo-ui-kit/react';
import { FriendRequests } from './requests';
import { FriendsList } from './friends-tab';
import { RoomHistory } from './history';


export const FriendsDialog = observer(({ open, onClose }: { open: boolean; onClose(): void }) => {
  useLocale();
  const state = store.inbox;
  const inbox = state.type === 'inbox' ? state : undefined;
  const [tab, setTab] = useState('friends');
  const tabs = [
    { value: 'friends', label: tr('friends'), icon: 'users', content: inbox && <FriendsList inbox={inbox} /> },
    { value: 'requests', label: <>{tr('friendsTabRequests')}&nbsp;<Badge size="sm">{inbox?.friendRequests.length ?? 0}</Badge></>,
      icon: 'person', content: inbox && <FriendRequests inbox={inbox} /> },
    { value: 'history', label: tr('friendsTabHistory'), icon: 'history', content: <RoomHistory /> },
  ];
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }} width="wide"
    icon="users" title={tr('friends')} description={tr('friendsIntro')}
    closeLabel={tr('closeDialog')} cancelLabel={false} confirmLabel={false}>
    {!inbox ? <Typography tone="muted" text={tr('socialOffline')} /> : <Stack gap={3}>
      <Tabs value={tab} onValueChange={setTab} label={tr('friends')} items={tabs} />
      {tabs.find(({ value }) => value === tab)?.content}
    </Stack>}
  </Dialog>;
});
