import { useNotify } from '../../providers/notifications';
import { observer } from 'mobx-react-lite';
import {
  Avatar,
  Beacon,
  Card,
  Icon,
  IconButton,
  LevelMeter,
  Popover,
  RotaryKnob,
  Stack,
  StatusIndicator,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMicrophoneToggles } from '../../app/desktop/shellBus';
import type { ParticipantDto } from '../../contracts/models';
import type { SocialPerson } from '../../contracts/social';
import { fixedKnobWidth } from '../../shared/ui/knobWidth';
import { roomVoiceSettings, useRoomVoice } from '../../providers/application';
import { store } from '../../providers/store';
import { usePersonPhoto } from '../social/usePersonPhoto';
import type { RoomVoiceSettings } from '../../contracts/models';
import { RoomPersonMenu } from './RoomPersonMenu';
import { useSpeakingLevel } from './useSpeakingLevel';

/** Input level above which a participant counts as singing. */
/** The kit's xs knob: the card's auto grid column would otherwise collapse it. */
const personKnobDiameter = 84;
const speakingThreshold = 0.04;
/** Radar rings around whoever is singing right now; only this wrapper follows the live level. */
const SpeakingBeacon = ({
  participant,
  live,
  children,
}: {
  participant: ParticipantDto;
  live: boolean;
  children: ReactNode;
}) => {
  const level = useSpeakingLevel(participant);
  return <Beacon active={live && level > speakingThreshold}>{children}</Beacon>;
};

const SpeakingMeter = ({
  participant,
  live,
  label,
}: {
  participant: ParticipantDto;
  live: boolean;
  label: string;
}) => {
  const level = useSpeakingLevel(participant);
  return (
    <LevelMeter
      active={live}
      value={Math.min(1, level * 4) * 100}
      label={label}
    />
  );
};

/** Shared singer effects, personal listening volume and mute. */
export const RoomPersonCard = observer(
  ({
    participant,
    person,
    hostControls,
    onTransferHost,
    onRemove,
  }: {
    participant: ParticipantDto;
    person?: SocialPerson;
    hostControls: boolean;
    onTransferHost(participant: ParticipantDto): void;
    onRemove(participant: ParticipantDto): void;
  }) => {
    useLocale();
    const voice = useRoomVoice();
    const photo = usePersonPhoto(person?.accountId, person?.avatarVersion ?? 0);
    const moreRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [preview, setPreview] = useState<Partial<RoomVoiceSettings>>({});
    const pendingEffects = useRef(new Map<keyof RoomVoiceSettings, number>());
    const effectRevision = useRef(0);
    const effects = participant.voiceSettings
      ? { ...participant.voiceSettings, ...preview }
      : undefined;
    const notify = useNotify();
    const [listeningGain, setListeningGain] = useState(
      () => voice?.participantVolume(participant.id) ?? 2,
    );
    const changeVolume = (value: number) => {
      if (participant.self) {
        store.updatePreferences({ voiceGain: value });
        return;
      }
      setListeningGain(value);
      void voice
        ?.setParticipantVolume(participant.id, value)
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : String(error),
            'error',
          ),
        );
    };
    const [muted, setMuted] = useState(() =>
      participant.self
        ? !(voice?.microphoneEnabled() ?? true)
        : (voice?.participantMuted(participant.id) ?? participant.muted),
    );
    const host = participant.role === 'host';
    // Re-read after the global mute hotkey switched the microphone from outside this button.
    const externalToggles = useMicrophoneToggles();
    useEffect(() => {
      if (voice)
        setMuted(
          participant.self
            ? !voice.microphoneEnabled()
            : voice.participantMuted(participant.id),
        );
    }, [voice, participant.id, participant.self, externalToggles]);
    useEffect(() => {
      if (!voice || participant.self) return;
      const gain = voice.participantVolume(participant.id);
      setListeningGain(gain);
      void voice
        .setParticipantVolume(participant.id, gain)
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : String(error),
            'error',
          ),
        );
    }, [voice, participant.id, participant.self, notify]);

    const toggleMute = async () => {
      if (!voice) return;
      const next = !muted;
      const update = participant.self
        ? voice.setMicrophoneEnabled(!next)
        : voice.setParticipantMuted(participant.id, next);
      // A refused command (e.g. an AudioService older than the button) leaves the button as it was.
      if (
        await update.then(
          () => true,
          () => false,
        )
      )
        setMuted(next);
    };
    const updateEffect = (effect: keyof RoomVoiceSettings, value: number) => {
      const revision = ++effectRevision.current;
      pendingEffects.current.set(effect, revision);
      setPreview((current) => ({ ...current, [effect]: value }));
      void roomVoiceSettings
        .change(participant.id, { [effect]: value })
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : String(error),
            'error',
          ),
        )
        .finally(() => {
          if (pendingEffects.current.get(effect) !== revision) return;
          pendingEffects.current.delete(effect);
          setPreview((current) => {
            const next = { ...current };
            delete next[effect];
            return next;
          });
        });
    };
    const muteLabel = participant.self
      ? tr(muted ? 'unmuteMicrophone' : 'muteMicrophone')
      : `${tr(muted ? 'unmute' : 'mute')}: ${participant.name}`;
    const effectsLabel = tr('participantEffects', { name: participant.name });

    return (
      <li className="participant" data-connected={participant.connected}>
        <Card
          border
          padding="sm"
          className="roomPerson"
          data-role={participant.role}
          data-self={participant.self || undefined}
        >
          <SpeakingBeacon
            participant={participant}
            live={participant.connected && !muted}
          >
            <Avatar
              size="lg"
              variant={participant.self ? 'host' : 'initials'}
              name={participant.name}
              src={photo}
              badge={host ? undefined : tr('guestBadge')}
            />
            {host && (
              <span className="roomPersonCrown">
                <Icon name="crown" size={12} />
              </span>
            )}
          </SpeakingBeacon>
          <div className="roomPersonMain">
            <Stack>
              <Typography
                as="strong"
                variant="title"
                truncate
                title={participant.name}
              >
                {participant.name}
              </Typography>
            </Stack>
            {!participant.connected && (
              <StatusIndicator
                status="offline"
                label={tr('readinessDisconnected')}
              />
            )}
            <SpeakingMeter
              participant={participant}
              live={participant.connected && !muted}
              label={tr('liveInputLevel')}
            />
          </div>
          <RotaryKnob
            diameter={personKnobDiameter}
            style={fixedKnobWidth(personKnobDiameter)}
            className="roomPersonKnob"
            min={0}
            max={4}
            step={0.01}
            resetValue={2}
            displayScale={25}
            label={tr('participantVolume', { name: participant.name })}
            disabled={!participant.self && !voice}
            value={
              participant.self ? store.preferences.voiceGain : listeningGain
            }
            onValueChange={changeVolume}
          />
          <Stack gap={1}>
            <IconButton
              round
              size="sm"
              variant={muted ? 'danger' : 'secondary'}
              icon={participant.self ? 'mic' : 'volume'}
              label={muteLabel}
              aria-pressed={muted}
              onClick={() => void toggleMute()}
            />
            <IconButton
              ref={moreRef}
              round
              size="sm"
              icon="sliders"
              label={effectsLabel}
              aria-pressed={menuOpen}
              aria-haspopup="dialog"
              onClick={() => setMenuOpen((open) => !open)}
            />
          </Stack>
        </Card>
        <Popover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchorRef={moreRef}
          label={effectsLabel}
          className="roomPersonPopover"
        >
          <RoomPersonMenu
            participant={participant}
            person={person}
            hostControls={hostControls}
            effects={effects}
            onEffect={updateEffect}
            onTransferHost={() => {
              setMenuOpen(false);
              onTransferHost(participant);
            }}
            onRemove={() => {
              setMenuOpen(false);
              onRemove(participant);
            }}
          />
        </Popover>
      </li>
    );
  },
);
