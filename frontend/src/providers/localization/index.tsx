import "../../i18n/messages";
import { addMessages, LocaleProvider } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useEffect, type PropsWithChildren } from 'react';
import { store } from '../store';
import en from './en.json';
import ru from './ru.json';
import uk from './uk.json';

const aliases = {
  'NetworkError when attempting to fetch resource.': 'Failed to fetch',
  'Load failed': 'Failed to fetch',
  'HTTP 408': 'TimeoutError',
  'HTTP 504': 'TimeoutError',
  'HTTP 502': 'HTTP 500',
  'HTTP 503': 'HTTP 500',
  'Изменить фото': 'changePhoto',
  '{label}: {value} · ведите по кругу или тяните за центр': 'rotaryHint',
} as const;

Object.entries({ en, ru, uk } satisfies Record<string, typeof uk>).forEach(
  ([locale, messages]) => {
    addMessages(locale, {
      ...messages,
      ...Object.fromEntries(
        Object.entries(aliases).map(([key, source]) => [key, messages[source]]),
      ),
    });
  },
);

const LocalizationProvider = observer(({ children }: PropsWithChildren) => {
  const { language: locale } = store.interface;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <LocaleProvider locale={locale}>{children}</LocaleProvider>;
});

export default LocalizationProvider;
