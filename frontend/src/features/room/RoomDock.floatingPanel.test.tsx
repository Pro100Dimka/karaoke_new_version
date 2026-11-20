import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearStorage,
  readJson,
  storageKey,
} from '../../shared/storage/localStore';
import { RoomDock } from './RoomDock';

vi.mock('@neo-ui-kit/react', async (original) => ({
  ...(await original<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ pathname: '/' }),
}));
vi.mock('../../providers/store', () => ({
  store: {
    online: {
      room: {
        code: 'ROOM',
        hostId: 'self',
        role: 'host',
        participants: [],
        playbackLocked: false,
        connectionStatus: 'connected',
      },
    },
  },
}));
vi.mock('../../providers/application', () => ({
  getRoomRuntime: () => ({ getProject: () => undefined }),
  useRoomMembership: () => null,
  useRoomLibraryCommands: () => null,
  roomSession: {},
}));
vi.mock('../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
vi.mock('../social/useRoomPeople', () => ({ useRoomPeople: () => new Map() }));
vi.mock('./RoomHeadCard', () => ({
  RoomHeadCard: () => (
    <label data-testid="monitoring">
      <input type="checkbox" />
      Monitor
    </label>
  ),
}));
vi.mock('./RoomLinkCard', () => ({ RoomLinkCard: () => null }));
vi.mock('./RoomPersonCard', () => ({ RoomPersonCard: () => null }));
vi.mock('../playlists/PlaylistDialog', () => ({ PlaylistDialog: () => null }));

beforeEach(() => {
  clearStorage();
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 1000);
  const bounds = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      return this instanceof HTMLElement && this.classList.contains('roomDock')
        ? new DOMRect(
            parseFloat(this.style.left) || 100,
            parseFloat(this.style.top) || 100,
            555,
            660,
          )
        : bounds.call(this);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const pointer = (target: HTMLElement, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
};

it('keeps the main-window room dock movable, cancellable and independent of labelled controls', () => {
  const view = render(<RoomDock />);
  const dock = view.container.querySelector<HTMLElement>('.roomDock');
  const label = view.container.querySelector<HTMLElement>('label');
  if (!dock || !label) throw new Error('Room dock controls unavailable');
  pointer(label, 'pointerdown', 110, 110);
  pointer(dock, 'pointermove', 160, 160);
  pointer(dock, 'pointerup', 160, 160);
  expect(readJson(storageKey('panelLayout.room'))).toBeNull();

  pointer(dock, 'pointerdown', 110, 110);
  pointer(dock, 'pointermove', 160, 160);
  pointer(dock, 'pointerup', 160, 160);
  expect(dock).toHaveStyle({ left: '150px', top: '150px' });
  expect(readJson(storageKey('panelLayout.room'))).toEqual({
    left: 150,
    top: 150,
    width: 555,
    height: 660,
  });

  pointer(dock, 'pointerdown', 160, 160);
  pointer(dock, 'pointermove', 200, 200);
  expect(dock).toHaveStyle({ left: '190px', top: '190px' });
  pointer(dock, 'pointercancel', 200, 200);
  expect(dock).toHaveStyle({ left: '150px', top: '150px' });
  expect(readJson(storageKey('panelLayout.room'))).toEqual({
    left: 150,
    top: 150,
    width: 555,
    height: 660,
  });
});
