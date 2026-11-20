import { tr } from '@neo-ui-kit/react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OnlineInbox } from '../../../../../contracts/social';
import { NotificationsProvider } from '../../../../../providers/notifications';
import { store } from '../../../../../providers/store';
import '../../../../../providers/localization';
import AppearancePanel from './index';

const api = vi.hoisted(() => ({
  convert: vi.fn(),
  setAvatar: vi.fn(),
  avatar: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));
vi.mock('../../../../../features/social/avatarImage', () => ({
  avatarFromFile: api.convert,
}));
vi.mock('../../../../../services/socialClient', () => ({ socialClient: api }));
vi.mock('./keyboardlighting/useKeyboardLighting', () => ({
  useKeyboardLighting: () => ({ capabilities: undefined }),
}));
vi.mock('../../../../../providers/radio', () => ({
  setRadioStation: vi.fn(),
  setRadioVolume: vi.fn(),
  toggleRadio: vi.fn(),
}));

const savedPhoto = 'data:image/png;base64,c2F2ZWQ=';
const converted = { mime: 'image/webp', data: 'bmV3LXBob3Rv' };
const updatedPhoto = `data:${converted.mime};base64,${converted.data}`;
const preview = 'blob:pending-profile-photo';
const inbox: OnlineInbox = {
  type: 'inbox',
  me: {
    accountId: 'me',
    displayName: 'Singer',
    friendCode: 'ABCD-2345',
    transferCode: '',
    avatarVersion: 1,
  },
  friends: [],
  friendRequests: [],
  outgoingRequests: [],
  invites: [],
  notices: [],
};
const originalPreferences = store.preferences;
const originalInbox = store.inbox;
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeEach(() => {
  vi.resetAllMocks();
  api.convert.mockResolvedValue(converted);
  api.setAvatar.mockResolvedValue({ ...inbox.me, avatarVersion: 2 });
  api.createObjectURL.mockReturnValue(preview);
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: api.createObjectURL },
    revokeObjectURL: { configurable: true, value: api.revokeObjectURL },
  });
  store.updatePreferences({
    language: 'ru',
    profilePhoto: savedPhoto,
    displayName: 'Singer',
    notificationVolume: 0,
  });
  store.setInbox(inbox);
});
afterEach(() => {
  cleanup();
  store.updatePreferences(originalPreferences);
  store.setInbox(originalInbox);
  for (const [name, descriptor] of [
    ['createObjectURL', originalCreate],
    ['revokeObjectURL', originalRevoke],
  ] as const) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

const openAppearance = () => {
  const view = render(
    <NotificationsProvider>
      <AppearancePanel />
    </NotificationsProvider>,
  );
  const choose = (file: File) => {
    const input =
      view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('The profile photo picker is missing');
    fireEvent.change(input, { target: { files: [file] } });
  };
  const photo = () =>
    screen
      .getByRole('img', { name: store.preferences.displayName })
      .querySelector('image')
      ?.getAttribute('href');
  const button = () =>
    screen.getByRole('button', {
      name: `${tr('changePhoto')}: ${store.preferences.displayName}`,
    });
  return { choose, photo, button };
};

it.each(['decode', 'upload'] as const)(
  'restores the saved profile photo after a failed %s and allows the same file to be retried',
  async (stage) => {
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    (stage === 'decode' ? api.convert : api.setAvatar).mockReturnValueOnce(
      pending,
    );
    const { choose, photo, button } = openAppearance();
    const name = screen.getByRole('textbox', { name: tr('displayName') });
    fireEvent.change(name, { target: { value: 'Updated singer' } });
    const autoUpdate = screen.getByRole('checkbox', { name: tr('autoUpdate') });
    fireEvent.click(autoUpdate);
    const autoUpdateValue = store.preferences.autoUpdate;
    const file = new File(['image'], 'portrait.png', { type: 'image/png' });
    expect(photo()).toBe(savedPhoto);

    choose(file);
    await waitFor(() => expect(button()).toBeDisabled());
    expect(photo()).toBe(preview);
    expect(store.preferences.profilePhoto).toBe(savedPhoto);
    const message =
      stage === 'decode' ? 'Image decode failed' : 'Upload failed';
    await act(async () => fail(new Error(message)));

    expect(await screen.findByText(message)).toBeVisible();
    expect(button()).toBeEnabled();
    expect(photo()).toBe(savedPhoto);
    expect(api.revokeObjectURL).toHaveBeenCalledWith(preview);
    expect(screen.getByRole('textbox', { name: tr('displayName') })).toBe(name);
    expect(name).toHaveValue('Updated singer');
    expect(store.preferences.autoUpdate).toBe(autoUpdateValue);
    expect(store.preferences.profilePhoto).toBe(savedPhoto);
    expect(api.setAvatar).toHaveBeenCalledTimes(stage === 'decode' ? 0 : 1);

    choose(file);
    await waitFor(() =>
      expect(store.preferences.profilePhoto).toBe(updatedPhoto),
    );
    await waitFor(() => expect(photo()).toBe(updatedPhoto));
    expect(api.convert).toHaveBeenCalledTimes(2);
    expect(api.setAvatar).toHaveBeenLastCalledWith(
      converted.mime,
      converted.data,
    );
    expect(button()).toBeEnabled();
  },
);

it('restores the initials after a failed first photo upload', async () => {
  store.updatePreferences({ profilePhoto: '' });
  store.setInbox({ ...inbox, me: { ...inbox.me, avatarVersion: 0 } });
  api.setAvatar.mockRejectedValueOnce(new Error('Upload failed'));
  const { choose, photo, button } = openAppearance();
  choose(new File(['image'], 'portrait.png', { type: 'image/png' }));
  expect(await screen.findByText('Upload failed')).toBeVisible();
  expect(button()).toBeEnabled();
  expect(photo()).toBeUndefined();
  expect(store.preferences.profilePhoto).toBe('');
});

it('keeps the successfully uploaded photo in the chooser and saved profile', async () => {
  const { choose, photo, button } = openAppearance();
  choose(new File(['image'], 'portrait.png', { type: 'image/png' }));
  await waitFor(() =>
    expect(store.preferences.profilePhoto).toBe(updatedPhoto),
  );
  await waitFor(() => expect(photo()).toBe(updatedPhoto));
  expect(api.setAvatar).toHaveBeenCalledExactlyOnceWith(
    converted.mime,
    converted.data,
  );
  expect(button()).toBeEnabled();
});
