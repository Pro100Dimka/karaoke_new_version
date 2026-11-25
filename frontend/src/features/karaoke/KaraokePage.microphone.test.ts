import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KaraokeScreen,
  microphoneAvailableForKaraoke,
  sceneVideoUrl,
} from './KaraokePage';

const exit = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  notify: vi.fn(),
}));
vi.mock('../../providers/store', () => ({
  store: {
    preferences: { theme: 'dark' },
    online: { room: { role: 'participant', collaborativeControl: false } },
  },
}));
vi.mock('../../providers/application', () => ({ useRoomPlayback: () => null }));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => exit.notify,
}));
vi.mock('../../app/desktop/shellBus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/desktop/shellBus')>()),
  usePublishNowPlaying: vi.fn(),
}));
vi.mock('./tv/karaokeTv', () => ({ useKaraokeTv: () => null }));
vi.mock('./useKaraokeShortcuts', () => ({ useKaraokeShortcuts: vi.fn() }));
vi.mock('./useKaraokeSession', () => ({
  useKaraokeSession: () => ({
    load: { kind: 'notFound' },
    state: { kind: 'playing' },
    confirmExit: exit.confirm,
    autoHideConsole: false,
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KaraokePage microphone availability', () => {
  it('checks room exit permission before finalizing a guest recording', () => {
    render(
      createElement(KaraokeScreen, {
        songId: 'song',
        mode: 'RoomPrepared',
        target: document.body,
        host: window,
        onTv: false,
        controls: { current: null },
        onLeave: vi.fn(),
        onFinished: vi.fn(),
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Библиотека|library/i }),
    );
    expect(exit.confirm).not.toHaveBeenCalled();
    expect(exit.notify).toHaveBeenCalledWith(expect.any(String), 'warning');
  });
  it("keeps a participant's live pitch visible after device enumeration transiently reports missing", () => {
    expect(microphoneAvailableForKaraoke('missing', 440)).toBe(true);
    expect(microphoneAvailableForKaraoke('missing', undefined)).toBe(false);
  });

  it("uses the transferred room clip instead of a participant's unrelated local scene", () => {
    expect(
      sceneVideoUrl(
        'RoomPrepared',
        'scene://local/clip-07.webm',
        'http://local/song/clip',
      ),
    ).toBe('http://local/song/clip');
    expect(
      sceneVideoUrl(
        'Normal',
        'scene://local/clip-07.webm',
        'http://local/song/clip',
      ),
    ).toBe('scene://local/clip-07.webm');
  });
});
