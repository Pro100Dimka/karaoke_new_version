import { observer } from "mobx-react-lite";
import { Avatar, Badge, Beacon, Card, Icon, IconButton, LevelMeter, Popover, RotaryKnob, Stack, StatusIndicator, Typography, tr, useLocale } from "@neo-ui-kit/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMicrophoneToggles } from "../../app/desktop/shellBus";
import type { ParticipantDto } from "../../contracts/models";
import type { SocialPerson } from "../../contracts/social";
import { fixedKnobWidth } from "../../shared/ui/knobWidth";
import { ru } from "../../i18n/messages.ru";
import { useRoomVoice } from "../../providers/application";
import { usePersonPhoto } from "../social/usePersonPhoto";
import type { ParticipantEffect } from "./participantEffects";
import { RoomPersonMenu, type ParticipantEffects } from "./RoomPersonMenu";
import { useSpeakingLevel } from "./useSpeakingLevel";

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

const noEffects: ParticipantEffects = {
  reverb: 0,
  echo: 0,
  delay: 0,
  noiseSuppression: 0,
  autoTune: 0,
  octave: 0,
};

/**
 * One participant: who they are, how loud they sing, their volume for you (none on your own card:
 * your microphone goes out at full level), the button that turns your own microphone off (only on
 * your card: nobody mutes another singer) and the effects and actions behind the sliders.
 */
export const RoomPersonCard = observer(({
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
  const [volume, setVolume] = useState(participant.volume);
  const [effects, setEffects] = useState(noEffects);
  // Only your own microphone can be turned off here; nobody mutes another singer.
  const [muted, setMuted] = useState(
    () => participant.self && !(voice?.microphoneEnabled() ?? true),
  );
  const host = participant.role === "host";
  useEffect(() => setVolume(participant.volume), [participant.volume]);
  // Re-read after the global mute hotkey switched the microphone from outside this button.
  const externalToggles = useMicrophoneToggles();
  useEffect(() => {
    if (voice && participant.self) setMuted(!voice.microphoneEnabled());
  }, [voice, participant.self, externalToggles]);

  const toggleMute = async () => {
    if (!voice) return;
    const next = !muted;
    // A refused command (e.g. an AudioService older than the button) leaves the button as it was.
    if (
      await voice.setMicrophoneEnabled(!next).then(
        () => true,
        () => false,
      )
    )
      setMuted(next);
  };
  const updateEffect = (effect: ParticipantEffect, value: number) => {
    if (!voice) return;
    setEffects((current) => ({ ...current, [effect]: value }));
    void voice.setParticipantEffect(participant.id, effect, value);
  };
  const muteLabel = tr(ru[muted ? "unmuteMicrophone" : "muteMicrophone"]);
  const effectsLabel = tr(ru.participantEffects, { name: participant.name });

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
            size={host ? "md" : "lg"}
            variant={host ? "host" : "initials"}
            name={participant.name}
            src={photo}
            badge={host ? undefined : tr(ru.guestBadge)}
          />
        </SpeakingBeacon>
        <div className="roomPersonMain">
          <Stack>
            <Typography
              as="strong"
              variant="title"
              truncate
              title={participant.name}
            >
              {host && !photo && (
                <Icon name="crown" className="roomPersonCrown" />
              )}
              {participant.name}
            </Typography>
          </Stack>
          {!participant.connected && (
            <StatusIndicator
              status="offline"
              label={tr(ru.readinessDisconnected)}
            />
          )}
          <Stack direction="row" gap={1} align="center">
            <SpeakingMeter
              participant={participant}
              live={participant.connected && !muted}
              label={tr(ru.liveInputLevel)}
            />
            {participant.self && (
              <Badge tone="info" className="roomPersonYou">
                {tr(ru.you)}
              </Badge>
            )}
          </Stack>
        </div>
        {/* Your own microphone uses the saved settings; this card controls other singers' levels. */}
        {!participant.self && (
          <RotaryKnob
            diameter={personKnobDiameter}
            style={fixedKnobWidth(personKnobDiameter)}
            className="roomPersonKnob"
            min={0}
            max={2}
            step={0.01}
            resetValue={1}
            displayScale={100}
            label={tr(ru.participantVolume, { name: participant.name })}
            value={volume}
            onValueChange={setVolume}
            onValueCommit={(value) =>
              void voice?.setParticipantVolume(participant.id, value)
            }
          />
        )}
        <Stack gap={1}>
          {participant.self && (
            <IconButton
              round
              size="sm"
              variant={muted ? "danger" : "secondary"}
              icon="mic"
              label={muteLabel}
              aria-pressed={muted}
              onClick={() => void toggleMute()}
            />
          )}
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
});
