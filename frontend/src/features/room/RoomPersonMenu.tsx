import { Button, RotaryKnob } from "@ad-voice/ui";
import type { ParticipantDto } from "../../contracts/models";
import type { SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { useSocialAction } from "../social/useSocialAction";
import { participantEffectKnobs, type ParticipantEffect } from "./participantEffects";
import { SelfVoiceEffects } from "./SelfVoiceEffects";

export type ParticipantEffects = Record<ParticipantEffect, number>;

/**
 * Everything behind a participant's sliders button: the voice effects (your own, or how this
 * participant sounds to you), and what can be done with them: make host, remove, add as a friend.
 */
export const RoomPersonMenu = ({ participant, person, hostControls, effects, onEffect, onTransferHost, onRemove }: {
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
  const incoming = person?.relation === "Incoming";
  const befriend = person && (person.relation === "None" || incoming);
  const addFriend = () => person && void run(
    () => incoming ? socialClient.acceptFriend(person.accountId) : socialClient.requestFriend({ accountId: person.accountId }),
    t(incoming ? "friendAdded" : "friendRequestSent", { name: person.displayName }),
  );
  const manage = hostControls && !participant.self;

  return (
    <div className="roomPersonMenu">
      <div className="roomEffectKnobs">
        {participant.self ? <SelfVoiceEffects /> : participantEffectKnobs.map(effect => (
          <RotaryKnob key={effect.id} size="xs" showLabel label={t(effect.label)} min={effect.min} max={effect.max} step={effect.step}
            displayScale={effect.displayFactor} suffix={effect.valueSuffix} resetValue={0}
            value={effects[effect.id]} onValueChange={value => onEffect(effect.id, value)} />
        ))}
      </div>
      {(befriend || manage) && (
        <div className="roomPersonActions">
          {befriend && (
            <Button size="sm" icon="person" disabled={busy} onClick={addFriend}>{t(incoming ? "acceptAction" : "addFriend")}</Button>
          )}
          {manage && <>
            <Button size="sm" icon="crown" onClick={onTransferHost}>{t("transferHostAction", { name: participant.name })}</Button>
            <Button size="sm" variant="danger" icon="leave" onClick={onRemove}>{t("removeParticipant", { name: participant.name })}</Button>
          </>}
        </div>
      )}
    </div>
  );
};
