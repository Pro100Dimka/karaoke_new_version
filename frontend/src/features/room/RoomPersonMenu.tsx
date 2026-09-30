import { Crown, UserPlus, UserRoundX } from "lucide-react";
import type { ParticipantDto } from "../../contracts/models";
import type { SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { Button, RotaryKnob } from "../../theme/ui";
import { useSocialAction } from "../social/useSocialAction";
import { participantEffectKnobs, type ParticipantEffect } from "./participantEffects";
import { SelfVoiceEffects } from "./SelfVoiceEffects";

export type ParticipantEffects = Record<ParticipantEffect, number>;

/**
 * Everything behind a participant's sliders button: the voice effects (your own, or how this
 * participant sounds to you), and what can be done with them: make host, remove, add as a friend.
 */
export const RoomPersonMenu = ({
  participant,
  person,
  hostControls,
  effects,
  onEffect,
  onTransferHost,
  onRemove,
}: {
  participant: ParticipantDto;
  person?: SocialPerson;
  hostControls: boolean;
  effects: ParticipantEffects;
  onEffect(effect: ParticipantEffect, value: number): void;
  onTransferHost(): void;
  onRemove(): void;
}) => {
  const t = useText();
  const { busy, run } = useSocialAction();
  const befriend = person && (person.relation === "None" || person.relation === "Incoming");
  const addFriend = () => person && void run(
    () => person.relation === "Incoming" ? socialClient.acceptFriend(person.accountId) : socialClient.requestFriend({ accountId: person.accountId }),
    t(person.relation === "Incoming" ? "friendAdded" : "friendRequestSent", { name: person.displayName }),
  );
  return (
    <>
      <div className="participantEffectKnobs">
        {participant.self ? <SelfVoiceEffects /> : participantEffectKnobs.map(effect => (
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
            onChange={value => onEffect(effect.id, value)}
          />
        ))}
      </div>
      {(befriend || (hostControls && !participant.self)) && (
        <div className="participantActions">
          {befriend && (
            <Button size="sm" variant="outlined" disabled={busy} startIcon={<UserPlus size={16} />} onClick={addFriend}>
              {t(person.relation === "Incoming" ? "acceptAction" : "addFriend")}
            </Button>
          )}
          {hostControls && !participant.self && <>
            <Button size="sm" variant="outlined" startIcon={<Crown size={16} />} onClick={onTransferHost}>
              {t("transferHostAction", { name: participant.name })}
            </Button>
            <Button size="sm" variant="outlined" tone="danger" startIcon={<UserRoundX size={16} />} onClick={onRemove}>
              {t("removeParticipant", { name: participant.name })}
            </Button>
          </>}
        </div>
      )}
    </>
  );
};
