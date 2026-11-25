import { Button, tr, useLocale, useRouter } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import type { ParticipantDto } from '../../contracts/models';
import {
  getRoomRuntime,
  roomSession,
  useRoomMembership,
  useRoomLibraryCommands,
} from '../../providers/application';
import { ask } from '../../providers/dialog';
import { useNotify } from '../../providers/notifications';
import { store } from '../../providers/store';
import { errorstring, toAppError } from '../../shared/errors';

import { DetachedPanel } from '../../shared/ui/DetachedPanel';
import { useDetachedPanel } from '../../shared/ui/useDetachedPanel';
import { useTopModal } from '../../shared/ui/modalPlacement';
import {
  controlSelector,
  useFloatingPanel,
  useMeasuredPanelSize,
  useStoredPanelLayout,
} from '../../shared/ui/useFloatingPanel';
import { useRoomPeople } from '../social/useRoomPeople';
import './room-dock.css';
import { RoomHeadCard } from './RoomHeadCard';
import { RoomPersonCard } from './RoomPersonCard';
import { PlaylistDialog } from '../playlists/PlaylistDialog';
import { canControlRoom } from '../../application/room/roomModel';

// The room panel's window starts at the size of the in-app dock.
const roomPanelSize = { width: 555, height: 660 };

export const RoomDock = observer(() => {
  const { room } = store.online;
  const membership = useRoomMembership();
  const roomLibrary = useRoomLibraryCommands();
  const [playlistsOpen, setPlaylistsOpen] = useState(false);
  const runtime = getRoomRuntime();
  const { pathname } = useRouter();
  const notify = useNotify();
  useLocale();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const isHost = room?.role === 'host';
  const people = useRoomPeople(room);
  const outsideEditor = !pathname.startsWith('/editor/');
  const visible = Boolean(room) && outsideEditor;
  // The dock is dragged anywhere in the app by its surface, and past the window's edge into a window.
  const placement = useStoredPanelLayout('room');
  const panel = useDetachedPanel(
    'room',
    tr('onlineRoom'),
    roomPanelSize,
    placement.save,
    visible,
  );
  const frameRef = useRef<HTMLElement>(null);
  const modal = useTopModal();
  const grab = useRef<{
    x: number;
    y: number;
    pointerId: number;
    detaching?: boolean;
  } | null>(null);
  const measuredSize = useMeasuredPanelSize(
    frameRef,
    roomPanelSize,
    visible && !collapsed && !panel.detached,
  );
  const floating = useFloatingPanel(frameRef, {
    layout: placement.layout && { ...placement.layout, ...measuredSize },
    onLayoutChange: placement.save,
    defaultSize: measuredSize,
  });
  const beginMove = (event: PointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest(controlSelector)
    )
      return;
    const box = event.currentTarget.getBoundingClientRect();
    grab.current = {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      pointerId: event.pointerId,
    };
    floating.beginMove(event);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (held?.pointerId === event.pointerId) {
      if (held.detaching) return;
      const left = event.clientX - held.x;
      const top = event.clientY - held.y;
      if (
        left < 0 ||
        top < 0 ||
        left + measuredSize.width > window.innerWidth ||
        top + measuredSize.height > window.innerHeight
      ) {
        held.detaching = true;
        panel.detach(
          {
            ...measuredSize,
            left: event.screenX - held.x,
            top: event.screenY - held.y,
          },
          event,
        );
        return;
      }
    }
    floating.handleMove(event);
  };
  useLayoutEffect(() => {
    if (panel.detached) {
      grab.current = null;
      floating.handleCancel();
      return;
    }
    const frame = frameRef.current;
    const size = frame?.getBoundingClientRect();
    const placed = placement.layout;
    if (
      panel.heldPointer.current &&
      size &&
      placed &&
      (Math.abs(size.x - placed.left) > 1 || Math.abs(size.y - placed.top) > 1)
    )
      return;
    if (
      size?.width === measuredSize.width &&
      size.height === measuredSize.height
    )
      panel.resumeDrag(frame);
  });
  // The dock stays out of the way while the Melody Editor owns the screen.
  if (!room || !outsideEditor) return null;

  const failure = (error: unknown) =>
    notify(
      tr(errorstring(toAppError(error)) ?? 'roomNetworkUnavailable'),
      'error',
    );

  const handleCopy = async () => {
    await membership?.copyInvite();
    setCopied(true);
  };

  const handleLeave = async () => {
    const others = room.participants.filter((person) => !person.self).length;
    if (isHost && others > 0) {
      const choice = await ask({
        title: tr('hostLeavingTitle'),
        body: tr('hostLeavingBody'),
        actions: [
          { id: 'cancel', label: tr('cancel') },
          { id: 'transfer', label: tr('transferHost'), appearance: 'primary' },
          { id: 'close', label: tr('closeRoom'), appearance: 'secondary' },
        ],
      });
      if (choice === 'cancel' || choice === null) return;
      if (choice === 'close') {
        try {
          await roomSession.close();
        } catch (error) {
          failure(error);
        }
        return;
      }
      if (choice !== 'transfer') return;
    }
    try {
      await roomSession.leave();
    } catch (error) {
      failure(error);
    }
  };

  const transferHost = async (participant: ParticipantDto) => {
    try {
      await membership?.transferHost(participant.id);
    } catch (error) {
      failure(error);
    }
  };

  const removeParticipant = async (participant: ParticipantDto) => {
    const choice = await ask({
      title: tr('removeParticipantTitle'),
      body: tr('removeParticipantBody', { name: participant.name }),
      tone: 'warning',
      actions: [
        { id: 'cancel', label: tr('cancel') },
        {
          id: 'remove',
          label: tr('removeParticipant', { name: participant.name }),
          appearance: 'primary',
        },
      ],
    });
    if (choice !== 'remove') return;
    try {
      await membership?.removeParticipant(participant.id);
    } catch (error) {
      failure(error);
    }
  };

  const retryTransfer = async () => {
    try {
      await runtime.getProject()?.retry();
    } catch (error) {
      failure(error);
    }
  };

  const collapseLabel = tr(collapsed ? 'expandRoom' : 'collapseRoom');

  const cancelTransfer = () => {
    runtime.getProject()?.cancelTransfer();
  };
  const replaceProject = () => {
    void runtime.getProject()?.replaceProject().catch(failure);
  };

  return (
    <>
      <DetachedPanel panel={panel} modal={modal} keepMounted>
        {collapsed && !panel.detached ? (
          <div className="roomDockCollapsed">
            <Button
              icon="window"
              aria-label={collapseLabel}
              onClick={() => setCollapsed(false)}
            >
              {room.code}
            </Button>
          </div>
        ) : (
          <aside
            className="roomDock"
            aria-label={tr('onlineRoom')}
            ref={frameRef}
            style={
              !panel.detached && floating.layout
                ? {
                    left: floating.layout.left,
                    top: floating.layout.top,
                    bottom: 'auto',
                    right: 'auto',
                  }
                : undefined
            }
            onPointerDown={panel.detached ? undefined : beginMove}
            onPointerMove={panel.detached ? undefined : move}
            onPointerUp={
              panel.detached
                ? undefined
                : () => {
                    grab.current = null;
                    floating.handleUp();
                  }
            }
            onPointerCancel={
              panel.detached
                ? undefined
                : () => {
                    grab.current = null;
                    floating.handleCancel();
                  }
            }
          >
            <RoomHeadCard
              room={room}
              actions={{
                copied,
                detached: panel.detached,
                onCopy: () => void handleCopy(),
                onTogglePanel: panel.detached
                  ? panel.attach
                  : () => setCollapsed(true),
                onCancelTransfer: cancelTransfer,
                onRetryTransfer: () => void retryTransfer(),
                onReplaceProject: replaceProject,
                onLeave: () => void handleLeave(),
                onPlaylists: () => setPlaylistsOpen(true),
              }}
            />
            <ul className="roomPeople" aria-label={tr('participants')}>
              {room.participants.map((participant) => (
                <RoomPersonCard
                  key={participant.id}
                  participant={participant}
                  person={people.get(participant.id)}
                  hostControls={isHost}
                  onTransferHost={(target) => void transferHost(target)}
                  onRemove={(target) => void removeParticipant(target)}
                />
              ))}
            </ul>
          </aside>
        )}
      </DetachedPanel>
      {playlistsOpen && (
        <PlaylistDialog
          songs={[
            ...new Map(
              (room.sharedSongs ?? []).map((song) => [
                song.songId,
                {
                  id: song.songId,
                  title: song.title,
                  artist: song.artist,
                  status: 'ready' as const,
                  activeRevision: song.revision,
                },
              ]),
            ).values(),
          ]}
          onClose={() => setPlaylistsOpen(false)}
          disabled={!canControlRoom(room) || Boolean(room.songId)}
          onPlay={async (playlist, songs) => {
            await roomLibrary?.startPlaylist(
              playlist.name,
              songs.map((song) => ({
                songId: song.id,
                revision: song.activeRevision,
              })),
            );
          }}
        />
      )}
    </>
  );
});
