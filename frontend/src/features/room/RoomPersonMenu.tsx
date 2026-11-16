import { friendRelations } from '../../providers/social';
import { Button, RotaryKnob, Stack, tr, useLocale } from '@neo-ui-kit/react';
import type { ParticipantDto, RoomVoiceSettings } from '../../contracts/models';
import type { SocialPerson } from '../../contracts/social';

import { useSocialAction } from '../social/useSocialAction';
import { SelfVoiceEffects } from './SelfVoiceEffects';
import {
  effectFromKnob,
  effectToKnob,
  voiceEffects,
} from '../karaoke/console/voiceEffects';

/**
 * The singer's shared voice effects and participant actions.
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
  effects?: RoomVoiceSettings;
  onEffect(effect: keyof RoomVoiceSettings, value: number): void;
  onTransferHost(): void;
  onRemove(): void;
}) => {
  useLocale();
  const { busy, run } = useSocialAction();
  const friends = friendRelations;
  const incoming = person?.relation === 'Incoming';
  const befriend = person && (person.relation === 'None' || incoming);
  const addFriend = () =>
    person &&
    void run(
      () => friends.befriend(person),
      tr(incoming ? 'friendAdded' : 'friendRequestSent', {
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
          [
            ...voiceEffects,
            {
              id: 'noiseSuppression' as const,
              label: 'noiseSuppression',
              min: 0,
              max: 1,
              step: 0.01,
              initial: 0,
            },
          ].map((effect) => (
            <RotaryKnob
              key={effect.id}
              size="xs"
              showLabel
              label={tr(effect.label)}
              min={effect.min}
              max={effect.max}
              step={effect.step}
              displayScale={100}
              suffix="%"
              resetValue={effect.initial}
              disabled={!effects}
              value={effectToKnob(effects?.[effect.id] ?? 0)}
              onValueChange={(value) =>
                onEffect(effect.id, effectFromKnob(value))
              }
            />
          ))
        )}
      </div>
      {(befriend || manage) && (
        <Stack gap={2}>
          {befriend && (
            <Button size="sm" icon="person" disabled={busy} onClick={addFriend}>
              {tr(incoming ? 'acceptAction' : 'addFriend')}
            </Button>
          )}
          {manage && (
            <>
              <Button size="sm" icon="crown" onClick={onTransferHost}>
                {tr('transferHostAction', { name: participant.name })}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="leave"
                onClick={onRemove}
              >
                {tr('removeParticipant', { name: participant.name })}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
};
