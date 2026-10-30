import { friendRelations } from "../../../../providers/social";
import {
  Button,
  IconButton,
  Popover,
  Stack,
  TextField,
  Tooltip,
  tr,
  Typography,
  type IconButtonProps,
} from '@neo-ui-kit/react';
import { useIsMutating, useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  useErrorHandler,
  useNotify,
} from '../../../../providers/notifications';

import type { OnlineInbox } from '../../../../contracts/social';
type FriendRequestAction = 'accept' | 'decline' | 'cancel';
import FriendsList from './list';

const config = {
  accept: { icon: 'check', label: 'acceptAction', variant: 'primary' },
  decline: { icon: 'close', label: 'declineAction' },
  cancel: { icon: 'close', label: 'cancelRequest' },
} satisfies Record<FriendRequestAction, IconButtonProps>;

const mutationKey = ['friend-requests'];

export const FriendRequests = ({ inbox }: { inbox: OnlineInbox }) => {
  const friends = friendRelations;
  const notify = useNotify();
  const onError = useErrorHandler();
  const request = useMutation({
    mutationKey,
    mutationFn: (operation: () => Promise<string | void>) => operation(),
    onSuccess: (message) => message && notify(message),
    onError,
  });
  const busy = useIsMutating({ mutationKey }) > 0;
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  const { friendCode } = inbox.me;
  const copy = async () => {
    await friends.copyCode(friendCode);
    return tr('codeCopied');
  };
  const send = async () => {
    const { person } = await friends.requestByCode(code);
    setCode('');
    setOpen(false);
    return tr('friendRequestSent', { name: person.displayName });
  };
  const groups = (
    [
      ['incomingRequests', inbox.friendRequests, ['accept', 'decline']],
      ['outgoingRequests', inbox.outgoingRequests, ['cancel']],
    ] as const
  ).filter(([, rows]) => rows.length);

  return (
    <Stack gap={4}>
      <Stack direction="row" justify="between" align="center" wrap gap={2}>
        <Tooltip content={tr('myFriendCodeHint')}>
          <Button
            variant="ghost"
            endIcon="copy"
            label={`${tr('myFriendCode')}: ${friendCode}`}
            aria-label={`${tr('copyCode')}: ${friendCode}`}
            disabled={busy}
            onClick={() => request.mutate(copy)}
          />
        </Tooltip>
        <Button
          ref={anchor}
          variant="primary"
          icon="person"
          label={tr('addFriend')}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen(!open)}
        />
      </Stack>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchor}
        label={tr('addFriend')}
      >
        <Stack
          as="form"
          gap={3}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && code.trim()) request.mutate(send);
          }}
        >
          <TextField
            label={tr('friendCodeField')}
            value={code}
            onValueChange={setCode}
            disabled={busy}
            required
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="primary"
            label={tr('sendFriendRequest')}
            disabled={busy || !code.trim()}
          />
        </Stack>
      </Popover>
      {groups.map(([title, rows, actions]) => (
        <Stack key={title} gap={2}>
          <Typography as="h3" variant="label" text={tr(title)} />
          <FriendsList
            rows={rows}
            actions={({ accountId, displayName: name }) =>
              actions.map((action) => <IconButton key={action} size="sm" variant="secondary" {...config[action]}
                label={tr(config[action].label, { name })} disabled={busy}
                onClick={() => request.mutate(async () => {
                  await friends[action](accountId);
                  if (action === 'accept') return tr('friendAdded', { name });
                })} />)
            }
          />
        </Stack>
      ))}
      {!groups.length && <Typography tone="muted" text={tr('noRequests')} />}
    </Stack>
  );
};

export default FriendRequests;
