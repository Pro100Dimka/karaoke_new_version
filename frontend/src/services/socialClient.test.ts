import { beforeEach, expect, it, vi } from 'vitest';
import { desktopClient } from './desktopClient';
import { socialClient } from './socialClient';

vi.mock('./desktopClient', () => ({
  desktopClient: { socialLatest: vi.fn(), onSocialInbox: vi.fn() },
}));
let push: (message: unknown) => void;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(desktopClient.onSocialInbox).mockImplementation((listener) => {
    push = listener;
    return () => {};
  });
});

it('publishes the offline state when reading the initial social snapshot fails', async () => {
  vi.mocked(desktopClient.socialLatest).mockRejectedValueOnce(
    new Error('IPC unavailable'),
  );
  const receive = vi.fn();
  const stop = socialClient.subscribe(receive);
  try {
    await vi.waitFor(() =>
      expect(receive).toHaveBeenCalledWith({ type: 'offline' }),
    );
  } finally {
    stop();
  }
});

it.each(['new push', 'unsubscribe'])(
  'ignores an initial snapshot failure after %s',
  async (event) => {
    let reject!: (error: Error) => void;
    const initial = new Promise<unknown>((_resolve, failed) => {
      reject = failed;
    });
    vi.mocked(desktopClient.socialLatest).mockReturnValueOnce(initial);
    const receive = vi.fn();
    const stop = socialClient.subscribe(receive);
    if (event === 'new push') push({ type: 'inbox' });
    else stop();
    receive.mockClear();
    reject(new Error('Old IPC request'));
    await initial.catch(() => undefined);
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
    stop();
  },
);
