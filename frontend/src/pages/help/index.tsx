import { openSettings } from '../library/modals/settings';
import { useLocale, Button, Card, tr, useRouter } from '@neo-ui-kit/react';
import { useState } from 'react';

import { ru } from '../../i18n/messages.ru';
import { routes } from '../../shared/routes';

const chapters = [
  ['start', 'rocket', ['helpStart', 'helpStart1', 'helpStart2']],
  [
    'audio',
    'headphones',
    ['helpAudio', 'helpAudio1', 'helpAudio2', 'helpAudio3'],
    'audio',
  ],
  [
    'models',
    'chip',
    ['helpModels', 'helpModels1', 'helpModels2', 'helpModels3'],
    'models',
  ],
  [
    'processing',
    'processing',
    ['helpProcessing', 'helpProcessing1', 'helpProcessing2', 'helpProcessing3'],
  ],
  [
    'library',
    'music',
    ['helpLibrary', 'helpLibrary1', 'helpLibrary2'],
    'library',
  ],
  [
    'karaoke',
    'mic',
    ['helpKaraoke', 'helpKaraoke1', 'helpKaraoke2', 'helpKaraoke3'],
  ],
  ['keys', 'key', ['helpKeys', 'helpKeys1', 'helpKeys2', 'helpKeys3']],
  ['editor', 'pencil', ['helpEditor', 'helpEditor1', 'helpEditor2']],
  [
    'recordings',
    'headphones',
    ['helpRecordings', 'helpRecordings1', 'helpRecordings2'],
  ],
  ['rooms', 'users', ['helpRooms', 'helpRooms1', 'helpRooms2', 'helpRooms3']],
  [
    'trouble',
    'wrench',
    ['helpTrouble', 'helpTrouble1', 'helpTrouble2', 'helpTrouble3'],
  ],
] as const;

export const HelpPage = () => {
  useLocale();
  const { navigate } = useRouter();
  const [active, setActive] = useState<(typeof chapters)[number]>(chapters[0]);
  const [activeId, , [activeTitle, ...paragraphs], image] = active;
  return (
    <main className="helpPage">
      <header className="helpHeader" data-window-drag>
        <Button icon="back" onClick={() => navigate(routes.library)}>
          {tr(ru.library)}
        </Button>
        <h1>{tr(ru.helpTitle)}</h1>
      </header>
      <div className="helpLayout">
        <nav className="helpNavigation" aria-label={tr(ru.helpTitle)}>
          {chapters.map((chapter) => {
            const [id, icon, [title]] = chapter;
            return (
              <Button
                key={id}
                icon={icon}
                variant={id === activeId ? 'primary' : 'ghost'}
                aria-current={id === activeId ? 'page' : undefined}
                onClick={() => setActive(chapter)}
              >
                {tr(ru[title])}
              </Button>
            );
          })}
        </nav>
        <Card className="helpArticle" padding="lg">
          <article key={activeId} aria-labelledby="helpChapterTitle">
            <h2 id="helpChapterTitle">{tr(ru[activeTitle])}</h2>
            {paragraphs.map((key) => (
              <p key={key}>{tr(ru[key])}</p>
            ))}
            {image && (
              <figure>
                <img
                  src={`${import.meta.env.BASE_URL}help/${image}.jpg`}
                  alt={tr(ru[activeTitle])}
                  loading="lazy"
                />
                <figcaption>{tr(ru.helpScreenshot)}</figcaption>
              </figure>
            )}
            {['audio', 'models'].includes(activeId) && (
              <Button
                icon="settings"
                onClick={() =>
                  openSettings(activeId === 'audio' ? 'audio' : 'ai')
                }
              >
                {tr(ru.settings)}
              </Button>
            )}
          </article>
        </Card>
      </div>
    </main>
  );
};

export default HelpPage;
