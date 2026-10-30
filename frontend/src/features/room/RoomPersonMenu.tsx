import { friendRelations } from "../../providers/social";
import { Button, RotaryKnob, Stack, tr, useLocale } from "@neo-ui-kit/react";
import type { ParticipantDto } from "../../contracts/models";
import type { SocialPerson } from "../../contracts/social";
import { ru } from "../../i18n/messages.ru";

import { useSocialAction } from "../social/useSocialAction";
import {
  participantEffectKnobs,
  type ParticipantEffect,
} from "./participantEffects";
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
  useLocale();
  const { busy, run } = useSocialAction();
  const friends = friendRelations;
  const incoming = person?.relation === "Incoming";
  const befriend = person && (person.relation === "None" || incoming);
  const addFriend = () =>
    person &&
    void run(
      () => friends.befriend(person),
      tr(ru[incoming ? "friendAdded" : "friendRequestSent"], {
        name: person.displayName,
      }),
    );
  const manage = hostControls && !participant.self;

  return (
    <Stack gap={3}>
      <div className="roomEffectKnobs">
        {participant.self ? (
          <SelfVoiceEffects />
        ) : (
          participantEffectKnobs.map((effect) => (
            <RotaryKnob
              key={effect.id}
              size="xs"
              showLabel
              label={tr(ru[effect.label])}
              min={effect.min}
              max={effect.max}
              step={effect.step}
              displayScale={effect.displayFactor}
              suffix={effect.valueSuffix}
              resetValue={0}
              value={effects[effect.id]}
              onValueChange={(value) => onEffect(effect.id, value)}
            />
          ))
        )}
      </div>
      {(befriend || manage) && (
        <Stack gap={2}>
          {befriend && (
            <Button size="sm" icon="person" disabled={busy} onClick={addFriend}>
              {tr(ru[incoming ? "acceptAction" : "addFriend"])}
            </Button>
          )}
          {manage && (
            <>
              <Button size="sm" icon="crown" onClick={onTransferHost}>
                {tr(ru.transferHostAction, { name: participant.name })}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="leave"
                onClick={onRemove}
              >
                {tr(ru.removeParticipant, { name: participant.name })}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
};
