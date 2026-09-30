import { MicOff, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import type { ParticipantDto } from "../../contracts/models";
import type { SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { LiveSignalWaveform } from "../../shared/ui/LiveSignalWaveform";
import { Popover, RotaryKnob } from "../../theme/ui";
import { usePersonPhoto } from "../social/usePersonPhoto";
import type { ParticipantEffect } from "./participantEffects";
import { RoomPersonMenu, type ParticipantEffects } from "./RoomPersonMenu";
import { CrownIcon } from "./CrownIcon";
import { GuestIcon } from "./GuestIcon";
import { SlidersIcon } from "./SlidersIcon";

const noEffects: ParticipantEffects = { reverb: 0, echo: 0, delay: 0, noiseSuppression: 0, autoTune: 0, octave: 0 };

/** The round badge of a participant: host or guest, with their photo when they have one. */
const PersonRing = ({ host, person }: { host: boolean; person?: SocialPerson }) => {
  const t = useText();
  const photo = usePersonPhoto(person?.accountId, person?.avatarVersion ?? 0);
  const Icon = host ? CrownIcon : GuestIcon;
  return (
    <div className={host ? "roomRing roomRing--host" : "roomRing"} aria-hidden>
      <span className="roomRingHalo" />
      <span className="roomRingOrbit" />
      <span className="roomRingNeon" />
      <span className="roomRingInner" />
      <span className="roomRingGlint roomRingGlint--top" />
      <span className="roomRingGlint roomRingGlint--left" />
      <span className="roomRingGlint roomRingGlint--right" />
      <div className="roomRingCore">
        {photo ? <img src={photo} alt="" draggable={false} /> : <Icon className="roomRingIcon" />}
        <span className="roomRingBadge">{t(host ? "hostBadge" : "guestBadge")}</span>
      </div>
    </div>
  );
};

/**
 * One participant: who they are, how loud they sing, their volume for you (your own microphone
 * on your own card), the microphone button and the effects and actions behind the sliders.
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
  const { preferences, updatePreferences } = useApp();
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [volume, setVolume] = useState(participant.volume);
  const [effects, setEffects] = useState(noEffects);
  const [muted, setMuted] = useState(() =>
    participant.self ? !audioClient.microphoneEnabled() : audioClient.participantMuted(participant.id));
  useEffect(() => setVolume(participant.volume), [participant.volume]);
  // Your own microphone is only off while you are in the room.
  useEffect(() => () => {
    if (participant.self && !audioClient.microphoneEnabled()) void audioClient.setMicrophoneEnabled(true).catch(() => undefined);
  }, [participant.self]);

  const toggleMute = async () => {
    const next = !muted;
    // A refused command (e.g. an AudioService older than the button) leaves the button as it was.
    const done = participant.self
      ? audioClient.setMicrophoneEnabled(!next)
      : audioClient.setParticipantMuted(participant.id, next);
    if (await done.then(() => true, () => false)) setMuted(next);
  };
  const updateEffect = (effect: ParticipantEffect, value: number) => {
    setEffects(current => ({ ...current, [effect]: value }));
    void audioClient.setParticipantEffect(participant.id, effect, value);
  };
  const muteLabel = participant.self
    ? t(muted ? "unmuteMicrophone" : "muteMicrophone")
    : t(muted ? "unmuteParticipant" : "muteParticipant", { name: participant.name });

  return (
    <li className={participant.role === "host" ? "roomCard roomPerson roomPerson--host participant" : "roomCard roomPerson participant"}
      data-connected={participant.connected}>
      <PersonRing host={participant.role === "host"} person={person} />
      <div className="roomPersonTitle">
        <strong className="roomPersonName" title={participant.name}>{participant.name}</strong>
        {participant.self && <span className="roomYouBadge">{t("you")}</span>}
        <span className="roomPersonPresence" data-connected={participant.connected}>
          {participant.connected
            ? <><i aria-hidden />{t(participant.self ? "roomYouSpeaking" : "roomParticipantListening")}</>
            : <WifiOff aria-label={t("readinessDisconnected")} />}
        </span>
      </div>
      <div className="roomPersonLevel">
        <LiveSignalWaveform
          compact
          active={participant.connected && !muted}
          level={Math.min(1, participant.speakingLevel * 4)}
          ariaLabel={t("liveInputLevel")}
          title={participant.name}
        />
      </div>
      <div className="roomPersonKnob">
        <RotaryKnob
          label={t("mixerMicrophone")}
          min={0}
          max={1}
          step={0.01}
          size="lg"
          // The reference's knob is 170 of its pixels across.
          sizeValue="calc(170 * var(--u))"
          displayFactor={100}
          valueSuffix="%"
          defaultValue={1}
          // Your own card is your microphone: the same stored volume as karaoke and the settings.
          value={participant.self ? preferences.voiceGain : volume}
          onChange={value => {
            if (participant.self) return updatePreferences({ voiceGain: value });
            setVolume(value);
            void audioClient.setParticipantVolume(participant.id, value);
          }}
        />
      </div>
      <button type="button" className="roomRoundButton roomRoundButton--mute" aria-pressed={muted} aria-label={muteLabel}
        title={muteLabel} onClick={() => void toggleMute()}>
        <MicOff aria-hidden />
      </button>
      <button ref={moreRef} type="button" className="roomRoundButton roomRoundButton--more" aria-pressed={menuOpen}
        aria-label={t("participantEffects", { name: participant.name })} onClick={() => setMenuOpen(open => !open)}>
        <SlidersIcon />
      </button>
      <Popover open={menuOpen} anchorRef={moreRef} onClose={() => setMenuOpen(false)} placement="right"
        className="participantEffectsPopover" aria-label={t("participantEffects", { name: participant.name })}>
        <RoomPersonMenu
          participant={participant}
          person={person}
          hostControls={hostControls}
          effects={effects}
          onEffect={updateEffect}
          onTransferHost={() => { setMenuOpen(false); onTransferHost(participant); }}
          onRemove={() => { setMenuOpen(false); onRemove(participant); }}
        />
      </Popover>
    </li>
  );
};
