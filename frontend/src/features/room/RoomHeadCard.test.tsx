import { tr } from '@neo-ui-kit/react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RoomStateDto } from '../../contracts/models';
import '../../providers/localization';
import { RoomHeadCard } from './RoomHeadCard';

const voice = vi.hoisted(() => ({
  subscribeTiming: vi.fn(),
  monitoringEnabled: () => false,
  monitoringStatus: vi.fn(async () => ({ monitoringSafetyTripped: false })),
}));
vi.mock('../../providers/application', () => ({ useRoomVoice: () => voice }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));

beforeEach(() => {
  voice.subscribeTiming.mockImplementation((listener) => {
    listener({
      roundTripMs: 32,
      deviceLatencyMs: 10,
      estimatedVoiceLatencyMs: 55,
      voiceDelayMs: 55,
      roomPlayoutDelayMs: 55,
      followMs: 0,
      packetsSent: 100,
      packetsReceived: 100,
      relayEchoes: 1,
      networkTransportRunning: true,
      networkSendEnabled: true,
      deviceStarvedFrames: 0,
      remotes: {},
    });
    return () => undefined;
  });
});

it('keeps room identity, monitoring and playlist actions in the same compact card', async () => {
  const room: RoomStateDto = {
    code: 'room-code',
    hostId: 'self',
    role: 'host',
    participants: [],
    playbackLocked: false,
    songId: 'song',
  };
  const actions = {
    copied: false,
    detached: false,
    onCopy: vi.fn(),
    onTogglePanel: vi.fn(),
    onCancelTransfer: vi.fn(),
    onRetryTransfer: vi.fn(),
    onReplaceProject: vi.fn(),
    onLeave: vi.fn(),
    onPlaylists: vi.fn(),
  };
  render(<RoomHeadCard room={room} actions={actions} />);
  const card = screen.getByLabelText(tr('onlineRoom'));
  const status = await screen.findByRole('status', {
    name: tr('roomSyncResult'),
  });
  expect(status.closest('.ad-card')).toBe(card);
  expect(
    within(card).getByRole('switch', { name: tr('monitoring') }),
  ).toBeVisible();
  const playlists = within(card).getByRole('button', { name: tr('playlists') });
  expect(playlists).toHaveClass('ad-icon-button');
  fireEvent.click(playlists);
  expect(actions.onPlaylists).toHaveBeenCalledOnce();
  expect(card.querySelector('img')).toBeNull();
});
