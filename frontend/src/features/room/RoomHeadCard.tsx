import {
  Button,
  Card,
  Icon,
  IconButton,
  Menu,
  ProgressBar,
  Stack,
  Typography,
  type MenuItemData,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { useRef, useState } from 'react';
import type { RoomStateDto } from '../../contracts/models';
import { useTransferEta } from './useTransferEta';

// The code is shown as its first four groups; copying gives all of it.
const shownCode = (code: string): string =>
  code.split('-').slice(0, 4).join('-');

interface RoomHeadActions {
  copied: boolean;
  detached: boolean;
  onCopy(): void;
  onTogglePanel(): void;
  onCancelTransfer(): void;
  onRetryTransfer(): void;
  onReplaceProject(): void;
  onLeave(): void;
}

/** What the transfer needs from the singer: wait for reconnection, retry, replace their copy, or just wait a few minutes. */
const TransferNote = ({
  room,
  actions,
  failure,
}: {
  room: RoomStateDto;
  actions: RoomHeadActions;
  failure?: 'local' | 'remote';
}) => {
  useLocale();
  const minutes = useTransferEta(
    room.transferId ?? room.songId,
    room.transferProgress,
  );
  if (room.connectionStatus === 'reconnecting')
    return (
      <Typography
        role="status"
        aria-label={tr('roomReconnecting')}
        variant="caption"
        tone="warning"
        className="roomHeadNote"
      >
        <Icon name="signal" />
        {tr('roomReconnecting')}
      </Typography>
    );
  if (failure) {
    const conflict = failure === 'local' && room.transferConflict === true;
    const failureMessage = {
      local: 'roomProjectTransferFailed',
      remote: 'roomParticipantTransferFailed',
    } as const;
    return (
      <div className="roomHeadNote">
        <Typography role="alert" variant="caption" tone="warning">
          {tr(conflict ? 'roomProjectConflict' : failureMessage[failure])}
        </Typography>
        {failure === 'local' && (
          <Button
            size="xs"
            icon={conflict ? 'migrate' : 'refresh'}
            onClick={
              conflict ? actions.onReplaceProject : actions.onRetryTransfer
            }
          >
            {tr(conflict ? 'roomReplaceProject' : 'retryTransfer')}
          </Button>
        )}
      </div>
    );
  }
  if (
    room.transferProgress === undefined ||
    room.transferProgress >= 100 ||
    minutes === undefined
  )
    return null;
  return (
    <Typography variant="caption" tone="muted">
      {minutes <= 1
        ? tr('transferRemainingSoon')
        : tr('transferRemaining', { minutes })}
    </Typography>
  );
};

/** The room: the selected song's picture, the code to share, what it is busy with, and its actions. */
export const RoomHeadCard = ({
  room,
  artwork,
  actions,
}: {
  room: RoomStateDto;
  artwork?: { title: string; url: string };
  actions: RoomHeadActions;
}) => {
  useLocale();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const failed = room.participants.filter(
    (person) => person.connected && person.readiness === 'failed',
  );
  const failure =
    room.transferError || failed.some((person) => person.self)
      ? 'local'
      : failed.length
        ? 'remote'
        : undefined;
  const progress = failure ? undefined : room.transferProgress;
  const transferring = progress !== undefined && progress < 100;
  const menu: MenuItemData[] = [
    ...(room.transferId && !failure
      ? [
          {
            id: 'cancel',
            label: tr('cancelTransfer'),
            icon: 'close',
            onSelect: actions.onCancelTransfer,
          },
        ]
      : []),
  ];

  return (
    <Card
      border
      padding="sm"
      className="roomHead"
      data-art={artwork ? '' : undefined}
      aria-label={tr('onlineRoom')}
    >
      {artwork && (
        <img className="roomArt" src={artwork.url} alt={artwork.title} />
      )}
      <div className="roomHeadBody">
        <div className="roomCodeRow">
          <Typography as="strong" variant="title" truncate title={room.code}>
            {shownCode(room.code)}
          </Typography>
          <IconButton
            size="xs"
            variant="ghost"
            icon={actions.copied ? 'check' : 'copy'}
            label={tr(actions.copied ? 'copied' : 'copyCode')}
            onClick={actions.onCopy}
          />
        </div>
        {transferring || failure ? (
          <Typography variant="caption" tone="muted" truncate>
            {tr('transferLabel')}
          </Typography>
        ) : null}
        {transferring && (
          <div className="roomProgressRow">
            <ProgressBar
              label={tr('projectTransfer', { progress })}
              value={progress}
            />
            <Typography variant="caption" weight="semibold">
              {progress}%
            </Typography>
          </div>
        )}
        <TransferNote room={room} actions={actions} failure={failure} />
      </div>
      <Stack gap={1} direction="row" align="center" className="roomHeadActions">
        {menu.length > 0 && (
          <IconButton
            ref={menuAnchor}
            size="sm"
            variant="ghost"
            icon="more"
            label={tr('roomActions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          />
        )}
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchorRef={menuAnchor}
          align="end"
          items={menu}
        />
      </Stack>
      <div
        className="roomFrameControls"
        style={{
          zIndex: 21,
          isolation: 'isolate',
          boxShadow: '0 0 0 2px var(--ad-background, #19080d)',
        }}
      >
        {[
          {
            icon: actions.detached ? 'window' : 'minus',
            label: tr(actions.detached ? 'panelAttach' : 'collapseRoom'),
            onClick: actions.onTogglePanel,
          },
          {
            icon: 'close',
            label: tr('leaveRoom'),
            onClick: actions.onLeave,
          },
        ].map(({ icon, label, onClick }) => (
          <IconButton
            key={icon}
            size="xs"
            variant="secondary"
            icon={icon}
            label={label}
            style={{ fontSize: '1rem', color: 'var(--ad-text)' }}
            onClick={onClick}
          />
        ))}
      </div>
    </Card>
  );
};
