import { libraryArticles } from './content.library';
import { karaokeArticles } from './content.karaoke';
import { onlineArticles } from './content.online';
import { settingsArticles } from './content.settings';
import type { SettingsTab } from '../../contracts/models';
import type { GuideVisual } from './visuals';

export const sections = {
  library: {
    title: 'Библиотека',
    icon: 'music',
    description: 'Добавьте песню и подготовьте её к исполнению.',
  },
  karaoke: {
    title: 'Караоке',
    icon: 'mic',
    description: 'Пойте, настройте звук и сохраните исполнение.',
  },
  online: {
    title: 'Онлайн',
    icon: 'users',
    description: 'Пригласите друзей и пойте вместе.',
  },
  settings: {
    title: 'Настройки',
    icon: 'settings',
    description: 'Оформление, устройства, обработка и обслуживание.',
  },
} as const;

export type SectionId = keyof typeof sections;
interface GuideStep {
  title: string;
  body: string;
  visual?: GuideVisual;
  settings?: SettingsTab;
  details?: [string, string];
  clip?: string;
}
export interface GuideArticle {
  id: string;
  section: SectionId;
  title: string;
  keywords: string;
  steps: GuideStep[];
  next: string;
}

export const articles: GuideArticle[] = [
  ...libraryArticles,
  ...karaokeArticles,
  ...onlineArticles,
  ...settingsArticles,
];

export const quickAnswers = ['no-mic', 'latency', 'processing-error'];

const normalize = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/ё/g, 'е')
    .replace(/(?<=\p{L})['’ʼ](?=\p{L})/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const ignoredWords = new Set(
  'как что хочу мне у меня не и в на с для почему где можно ли а або як що хочу мені у мене де та the a an i my how to do does is can want not'.split(
    ' ',
  ),
);

export const searchArticles = (
  query: string,
  translate: (text: string) => string,
) => {
  const words = normalize(query)
    .split(' ')
    .filter((word) => word && !ignoredWords.has(word));
  if (!words.length) return [];
  return articles
    .map((article) => {
      const fields = [
        translate(article.title),
        article.keywords,
        article.steps
          .flatMap(({ title, body, details }) =>
            [title, body, ...(details ?? [])].map(translate),
          )
          .join(' '),
      ].map((field) => normalize(field).split(' '));
      const matches = words.map((word) =>
        fields.findIndex((field) =>
          field.some(
            (candidate) =>
              candidate === word ||
              (word.length > 4 && candidate.startsWith(word.slice(0, -1))),
          ),
        ),
      );
      const score = matches.includes(-1)
        ? 0
        : matches.reduce((sum, field) => sum + fields.length - field, 0);
      return { article, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ article }) => article);
};
