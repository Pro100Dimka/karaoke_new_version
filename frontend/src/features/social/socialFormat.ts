import { tr } from '@neo-ui-kit/react';
import type { Language } from '../../contracts/models';
import type { SocialPerson } from '../../contracts/social';

const presenceKeys = {
  Online: 'presenceOnline',
  InRoom: 'presenceInRoom',
  Offline: 'presenceOffline',
} as const satisfies Record<SocialPerson['presence'], string>;

const relativeSteps = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
] as const;

/** "5 minutes ago", "yesterday"; in the app's language. */
export const since = (
  iso: string,
  language: Language,
  now = Date.now(),
): string => {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const [unit, size] = relativeSteps.find(([, step]) => seconds >= step) ?? [
    'minute',
    60,
  ];
  return format.format(-Math.floor(seconds / size), unit);
};

/** Online, in a room, or when they were last seen. */
export const presenceText = (
  person: SocialPerson,
  language: Language,
): string =>
  person.presence === 'Offline' && person.lastSeenAt
    ? tr('lastSeen', { when: since(person.lastSeenAt, language) })
    : tr(presenceKeys[person.presence]);

export const durationText = (seconds: number): string => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60
    ? tr('durationMinutes', { minutes })
    : tr('durationHoursMinutes', {
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
      });
};
