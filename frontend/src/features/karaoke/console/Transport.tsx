import { IconButton, tr, useLocale } from '@neo-ui-kit/react';
import { useMemo, useRef } from 'react';
import type { KaraokeState } from '../../../application/karaoke/karaokeMachine';

const skipSeconds = 10;

interface TransportProps {
  state: KaraokeState;
  position: number;
  duration: number;
  seekLocked: boolean;
  onSeek(seconds: number): void;
  onTogglePlay(): void;
  onStop(): void;
}

/** Restart, play/pause, stop and skip-forward buttons of the console's top row. */
export const Transport = ({
  state,
  position,
  duration,
  seekLocked,
  onSeek,
  onTogglePlay,
  onStop,
}: TransportProps) => {
  const locale = useLocale();
  const currentPosition = useRef(position);
  currentPosition.current = position;
  const playing = state.kind === 'playing';
  const usable = ['ready', 'playing', 'paused'].includes(state.kind);
  const disabled = seekLocked || !usable;
  return useMemo(() => {
    const actions = [
      {
        id: 'restart',
        label: 'restart',
        icon: 'back',
        primary: false,
        run: () => onSeek(0),
      },
      {
        id: 'play',
        label: playing ? 'pause' : 'play',
        icon: playing ? 'pause' : 'play',
        primary: true,
        run: onTogglePlay,
      },
      { id: 'stop', label: 'stop', icon: 'stop', primary: false, run: onStop },
      {
        id: 'forward',
        label: 'skipForward',
        icon: 'prev',
        primary: false,
        run: () =>
          onSeek(Math.min(duration, currentPosition.current + skipSeconds)),
      },
    ] satisfies readonly {
      id: string;
      label: string;
      icon: string;
      primary: boolean;
      run(): void;
    }[];

    return (
      <div
        className="transport"
        role="toolbar"
        aria-label={tr('transportControls')}
      >
        {actions.map((action) => (
          <IconButton
            key={action.id}
            round
            className={action.id === 'forward' ? 'transportForward' : undefined}
            size={action.primary ? 'lg' : 'md'}
            variant={action.primary ? 'primary' : 'secondary'}
            icon={action.icon}
            label={tr(action.label)}
            disabled={disabled}
            onClick={action.run}
          />
        ))}
      </div>
    );
  }, [playing, disabled, duration, onSeek, onTogglePlay, onStop, locale]);
};
