import { setLocale, tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OnlineInbox, SocialPerson } from '../../../../contracts/social';
import { NotificationsProvider } from '../../../../providers/notifications';
import '../../../../providers/localization';
import { FriendRequests } from './requests';

const friends = vi.hoisted(() => ({
  requestByCode: vi.fn(),
  copyCode: vi.fn(),
}));
vi.mock('../../../../providers/social', () => ({ friendRelations: friends }));

const inbox: OnlineInbox = {
  type: 'inbox',
  me: {
    accountId: 'me',
    displayName: 'Singer',
    friendCode: 'ABCD-2345',
    transferCode: '',
    avatarVersion: 0,
  },
  friends: [],
  friendRequests: [],
  outgoingRequests: [],
  invites: [],
  notices: [],
};
const person: SocialPerson = {
  accountId: 'friend',
  displayName: 'Anna',
  avatarVersion: 0,
  presence: 'Online',
  roomId: null,
  lastSeenAt: null,
  relation: 'Requested',
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(() => client.clear());

const openRequest = () => {
  render(
    <QueryClientProvider client={client}>
      <NotificationsProvider>
        <FriendRequests inbox={inbox} />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: tr('addFriend') }));
  const input = screen.getByRole('textbox', { name: tr('friendCodeField') });
  fireEvent.change(input, { target: { value: 'WRNG-1234' } });
  return input;
};
const submit = () =>
  fireEvent.click(
    screen.getByRole('button', { name: tr('sendFriendRequest') }),
  );

it.each(
  (['ru', 'uk', 'en'] as const).flatMap((locale) =>
    [
      {
        code: 'FriendCodeNotFound',
        message: 'No one has this friend code',
        key: 'social.errorFriendCodeNotFound',
      },
      {
        code: 'FriendIsSelf',
        message: 'You cannot add yourself as a friend',
        key: 'social.errorFriendIsSelf',
      },
    ].map((error) => ({ locale, ...error })),
  ),
)(
  'explains $code in $locale while preserving the code for correction and retry',
  async ({ locale, code, message, key }) => {
    setLocale(locale);
    friends.requestByCode
      .mockRejectedValueOnce({ code, message, source: 'python' })
      .mockResolvedValueOnce({ relation: 'Requested', person });
    const input = openRequest();
    submit();

    expect(await screen.findByText(tr(key))).toBeVisible();
    expect(input).toHaveValue('WRNG-1234');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: tr('sendFriendRequest') }),
      ).toBeEnabled(),
    );
    fireEvent.change(input, { target: { value: 'GOOD-2345' } });
    submit();
    expect(
      await screen.findByText(tr('friendRequestSent', { name: 'Anna' })),
    ).toBeVisible();
    expect(friends.requestByCode).toHaveBeenLastCalledWith('GOOD-2345');
    expect(screen.queryByRole('textbox')).toBeNull();
  },
);

it('preserves an unfamiliar server failure message and keeps retry available', async () => {
  setLocale('ru');
  friends.requestByCode.mockRejectedValueOnce({
    code: 'AccountTemporarilyUnavailable',
    message: 'Profile maintenance is in progress',
    source: 'python',
  });
  const input = openRequest();
  submit();
  expect(
    await screen.findByText('Profile maintenance is in progress'),
  ).toBeVisible();
  expect(input).toHaveValue('WRNG-1234');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: tr('sendFriendRequest') }),
    ).toBeEnabled(),
  );
});
