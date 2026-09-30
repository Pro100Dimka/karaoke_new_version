import { Crown, Ellipsis, Sparkles, UserRoundX, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import type { ParticipantDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import { LiveSignalWaveform } from "../../shared/ui/LiveSignalWaveform";
import { IconButton, Popover, RotaryKnob, Stack } from "../../theme/ui";
import type { SocialPerson } from "../../contracts/social";
import { AddFriendButton } from "../social/AddFriendButton";
import { PersonAvatar } from "../social/PersonAvatar";
import { SelfVoiceEffects } from "./SelfVoiceEffects";

const participantEffectKnobs = [
  {
    id: "reverb",
    label: "effectReverb",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "echo",
    label: "effectEcho",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "noiseSuppression",
    label: "noiseSuppression",
    min: 0,
    max: 1,
    step: 1,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "autoTune",
    label: "effectAutoTune",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "octave",
    label: "participantOctave",
    min: -1,
    max: 1,
    step: 1,
    displayFactor: 1,
    valueSuffix: "",
  },
] as const satisfies ReadonlyArray<{
  id: "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune";
  label: MessageKey;
  min: number;
  max: number;
  step: number;
  displayFactor: number;
  valueSuffix?: string;
}>;

export const Participant = ({
  participant,
  person,
  hostControls,
  onTransferHost,
  onRemove,
}: {
  participant: ParticipantDto;
  /** Who the participant is as a person (photo, friendship), once their app has said. */
  person?: SocialPerson;
  hostControls: boolean;
  onTransferHost(participant: ParticipantDto): void;
  onRemove(participant: ParticipantDto): void;
}) => {
  const t = useText();
  const { preferences, updatePreferences } = useApp();
  const roleLabel = participant.role === "host" ? t("host") : t("participant");
  const name = participant.self
    ? `${participant.name} · ${t("you")}`
    : participant.name;
  const ready = participant.readiness === "ready";
  const participantAnchor = useRef<HTMLLIElement | null>(null);
  const effectsAnchor = useRef<HTMLElement | null>(null);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [volume, setVolume] = useState(participant.volume);
  const [effects, setEffects] = useState({
    reverb: 0,
    echo: 0,
    delay: 0,
    noiseSuppression: 0,
    autoTune: 0,
    octave: 0,
  });
  const updateEffect = (
    effect: "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune",
    value: number,
  ) => {
    setEffects((current) => ({ ...current, [effect]: value }));
    void audioClient.setParticipantEffect(participant.id, effect, value);
  };
  useEffect(() => setVolume(participant.volume), [participant.volume]);

  const toggleEffects = () => setEffectsOpen((open) => !open);
  const hostActions = [
    {
      id: "transfer",
      label: t("transferHostAction", { name: participant.name }),
      icon: <Crown size={16} />,
      run: () => onTransferHost(participant),
    },
    {
      id: "effects",
      label: t("participantEffects", { name: participant.name }),
      icon: <Sparkles size={16} />,
      run: toggleEffects,
    },
    {
      id: "remove",
      label: t("removeParticipant", { name: participant.name }),
      icon: <UserRoundX size={16} />,
      destructive: true,
      run: () => onRemove(participant),
    },
  ] as const;

  return (
    <li className="participant" ref={participantAnchor}>
      <Stack className="participantMain">
        <Stack direction="row" align="center" gap={1}>
          <Stack sx={{ height: "100%" }}>
            <Stack direction="row" align="center" gap={1}>
              <PersonAvatar size="sm" accountId={person?.accountId} avatarVersion={person?.avatarVersion ?? 0} name={participant.name} />
              <strong>
                {participant.role === "host" && (
                  <Crown aria-label={t("host")} size={13} />
                )}{" "}
                {name}
              </strong>
              <AddFriendButton person={person} />
            </Stack>
            <LiveSignalWaveform
              compact
              active={participant.connected && !participant.muted}
              level={Math.min(1, participant.speakingLevel * 4)}
              ariaLabel={t("liveInputLevel")}
              title={participant.name}
              style={{ inlineSize: "unset" }}
            />
          </Stack>
          {hostControls && !participant.self && (
            <div className="participantActions">
              <ActionMenu
                iconOnly
                trigger={(triggerProps) => (
                  <IconButton
                    {...triggerProps}
                    size="xs"
                    variant="outline"
                    icon={Ellipsis}
                    label={t("moreActions")}
                  />
                )}
                items={hostActions}
              />
            </div>
          )}
          <RotaryKnob
            label={t(`mixerMicrophone`)}
            min={0}
            max={1}
            step={0.01}
            size="xs"
            displayFactor={100}
            valueSuffix="%"
            defaultValue={1}
            // Your own row is your microphone: the same stored volume as karaoke and the settings.
            value={participant.self ? preferences.voiceGain : volume}
            btnProps={{
              icon: <Sparkles aria-hidden />,
              onClick: toggleEffects,
              tooltip: t("participantEffects", { name: participant.name }),
              anchorRef: effectsAnchor,
              disabled: !hostControls && !participant.self,
              pressed: effectsOpen,
            }}
            onChange={(value) => {
              if (participant.self) return updatePreferences({ voiceGain: value });
              setVolume(value);
              void audioClient.setParticipantVolume(participant.id, value);
            }}
          />
        </Stack>
        {!participant.connected && (
          <WifiOff aria-label={t("readinessDisconnected")} size={14} />
        )}
      </Stack>
      <Popover
        open={effectsOpen}
        anchorRef={effectsAnchor}
        onClose={() => setEffectsOpen(false)}
        placement="right"
        className="participantEffectsPopover"
        aria-label={t("participantEffects", { name: participant.name })}
      >
        <div className="participantEffectKnobs">
          {participant.self ? <SelfVoiceEffects /> : participantEffectKnobs.map((effect) => (
            <RotaryKnob
              key={effect.id}
              label={t(effect.label)}
              min={effect.min}
              max={effect.max}
              step={effect.step}
              size="xs"
              displayFactor={effect.displayFactor}
              valueSuffix={effect.valueSuffix}
              defaultValue={0}
              value={effects[effect.id]}
              onChange={(value) => updateEffect(effect.id, value)}
            />
          ))}
        </div>
      </Popover>
    </li>
  );
};
