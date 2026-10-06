import {
  Avatar,
  Badge,
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
} from "@ad-voice/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ParticipantDto } from "../../contracts/models";
import type { SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { usePersonPhoto } from "../social/usePersonPhoto";
import type { ParticipantEffect } from "./participantEffects";
import { RoomPersonMenu, type ParticipantEffects } from "./RoomPersonMenu";
import { useSpeakingLevel } from "./roomSpeakingLevels";

/** Input level above which a participant counts as singing. */
const speakingThreshold = 0.04;
/** Radar rings around whoever is singing right now; only this wrapper follows the live level. */
const SpeakingBeacon = ({ participant, live, children }: { participant: ParticipantDto; live: boolean; children: ReactNode }) => {
  const level = useSpeakingLevel(participant);
  return <Beacon active={live && level > speakingThreshold}>{children}</Beacon>;
};

const SpeakingMeter = ({ participant, live, label }: { participant: ParticipantDto; live: boolean; label: string }) => {
  const level = useSpeakingLevel(participant);
  return <LevelMeter active={live} value={Math.min(1, level * 4) * 100} label={label} />;
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
 * your microphone goes out at full level), the microphone button and the effects and actions behind the sliders.
 */
export const RoomPersonCard = ({
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
  const t = useText();
  const photo = usePersonPhoto(person?.accountId, person?.avatarVersion ?? 0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [volume, setVolume] = useState(participant.volume);
  const [effects, setEffects] = useState(noEffects);
  const [muted, setMuted] = useState(() =>
    participant.self
      ? !audioClient.microphoneEnabled()
      : audioClient.participantMuted(participant.id),
  );
  const host = participant.role === "host";
  useEffect(() => setVolume(participant.volume), [participant.volume]);
  // Your own microphone is only off while you are in the room.
  useEffect(
    () => () => {
      if (participant.self && !audioClient.microphoneEnabled())
        void audioClient.setMicrophoneEnabled(true).catch(() => undefined);
    },
    [participant.self],
  );

  const toggleMute = async () => {
    const next = !muted;
    // A refused command (e.g. an AudioService older than the button) leaves the button as it was.
    const done = participant.self
      ? audioClient.setMicrophoneEnabled(!next)
      : audioClient.setParticipantMuted(participant.id, next);
    if (
      await done.then(
        () => true,
        () => false,
      )
    )
      setMuted(next);
  };
  const updateEffect = (effect: ParticipantEffect, value: number) => {
    setEffects((current) => ({ ...current, [effect]: value }));
    void audioClient.setParticipantEffect(participant.id, effect, value);
  };
  const muteLabel = participant.self
    ? t(muted ? "unmuteMicrophone" : "muteMicrophone")
    : t(muted ? "unmuteParticipant" : "muteParticipant", {
        name: participant.name,
      });
  const effectsLabel = t("participantEffects", { name: participant.name });

  return (
    <li className="participant" data-connected={participant.connected}>
      <Card
        border
        padding="sm"
        className="roomPerson"
        data-role={participant.role}
        data-self={participant.self || undefined}
      >
        <SpeakingBeacon participant={participant} live={participant.connected && !muted}>
          <Avatar
            size={host ? "md" : "lg"}
            variant={host ? "host" : "initials"}
            name={participant.name}
            src={photo}
            badge={host ? undefined : t("guestBadge")}
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
              label={t("readinessDisconnected")}
            />
          )}
          <Stack direction="row" gap={1} align="center">
            <SpeakingMeter participant={participant} live={participant.connected && !muted} label={t("liveInputLevel")} />
            {participant.self && <Badge tone="info">{t("you")}</Badge>}
          </Stack>
        </div>
        {/* Your own microphone goes out at full level in a room (see roomMicrophoneGain): no knob for it. */}
        {!participant.self && (
          <RotaryKnob
            size="xs"
            className="roomPersonKnob"
            min={0}
            max={2}
            step={0.01}
            resetValue={1}
            displayScale={100}
            label={t("participantVolume", { name: participant.name })}
            value={volume}
            onValueChange={setVolume}
            onValueCommit={(value) =>
              void audioClient.setParticipantVolume(participant.id, value)
            }
          />
        )}
        <Stack gap={1}>
          <IconButton
            round
            size="sm"
            variant={muted ? "danger" : "secondary"}
            icon="mic"
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
};
