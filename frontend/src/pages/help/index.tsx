import {
  Button, Dialog, Icon, TextField, tr, useLocale, useRouter,
} from '@neo-ui-kit/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { titleBarLeadingId } from '../../app/TitleBar';
import { store } from '../../providers/store';
import { openSettings } from '../library/modals/settings';
import { routes } from '../../shared/routes';
import {
  articles, quickAnswers, searchArticles, sections, type SectionId,
} from './content';
import { visuals, type GuideVisual } from './visuals';
import './help.css';

const settingsActions = {
  appearance: 'Открыть настройки внешнего вида',
  audio: 'Открыть настройки аудио',
  ai: 'Открыть настройки обработки',
  environment: 'Открыть ключи ENV',
  advanced: 'Открыть дополнительные настройки',
};
const sectionEntries = Object.entries(sections) as [
  SectionId, (typeof sections)[SectionId],
][];

export const HelpPage = observer(() => {
  useLocale();
  const { navigate } = useRouter();
  const { theme } = store.interface;
  const mediaRoot = import.meta.env.BASE_URL + 'help/' + (theme === 'dark' ? '' : theme + '/');
  const page = useRef<HTMLElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setSlot(document.getElementById(titleBarLeadingId));
  }, []);
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<SectionId | null>(null);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{
    visual: GuideVisual; title: string; number: number;
  } | null>(null);
  const article = articles.find(({ id }) => id === articleId);
  const nextArticle = articles.find(({ id }) => id === article?.next);
  const searching = Boolean(query.trim());
  const home = !section && !searching;
  const results = searching
    ? searchArticles(query, tr)
    : articles.filter((item) => item.section === section);

  const openArticle = (id: string) => {
    const next = articles.find((item) => item.id === id);
    if (!next) return;
    setArticleId(id);
    setSection(next.section);
    setQuery('');
    page.current?.scrollTo({ top: 0 });
  };
  const showSection = (id: SectionId | null) => {
    setSection(id);
    setArticleId(null);
    setQuery('');
    page.current?.scrollTo({ top: 0 });
  };
  const screenshot = (
    visual: GuideVisual, title: string, number: number, cropped = false,
  ) => {
    const { image, focus } = visuals[visual];
    const scale = cropped
      ? Math.max(1, Math.min(2.4, 78 / Math.max(focus[2], focus[3])))
      : 1;
    const translation = [focus[0] + focus[2] / 2, focus[1] + focus[3] / 2]
      .map((center) => Math.max(100 * (1 - scale), Math.min(0, 50 - center * scale)));
    return (
      <span className="helpScreen">
        <span
          className="helpScreenCanvas"
          style={{
            transform: 'translate(' + translation.join('%, ') + '%) scale(' + scale + ')',
            transformOrigin: '0 0',
          }}
        >
          <img
            src={mediaRoot + image + '.jpg'}
            alt={tr(title)} loading="lazy"
          />
          <span
            className="helpFocus" aria-hidden
            style={{
              left: focus[0] + '%', top: focus[1] + '%',
              width: focus[2] + '%', height: focus[3] + '%',
              borderWidth: 1.5 / scale,
            }}
          >
            <span style={{ transform: 'scale(' + (1 / scale) + ')' }}>{number}</span>
          </span>
        </span>
      </span>
    );
  };
  const header = (
    <header className="helpHeader" data-window-drag>
      <Button
        variant="ghost" icon="back"
        onClick={() => navigate(routes.library)} label={tr('Библиотека')}
      />
      <div className="helpHeaderTitle">
        <Icon name="document" size={18} />
        <span>{tr('Инструкция')}</span>
      </div>
    </header>
  );

  return (
    <div className="helpPage" data-home={home || undefined}>
      {slot ? createPortal(header, slot) : header}
      <div className="helpLayout">
        <nav className="helpSidebar" aria-label={tr('Разделы инструкции')}>
          <Button
            variant="ghost" icon="grid" label={tr('Обзор')}
            aria-current={!section && !searching ? 'page' : undefined}
            onClick={() => showSection(null)}
          />
          <span className="helpNavLabel">{tr('Разделы инструкции')}</span>
          {sectionEntries.map(([id, item]) => (
            <div className="helpNavGroup" key={id}>
              <Button
                variant="ghost" icon={item.icon} label={tr(item.title)}
                aria-current={section === id && !article && !searching ? 'page' : undefined}
                aria-expanded={section === id}
                onClick={() => showSection(id)}
              />
              {section === id && (
                <div className="helpSidebarTopics">
                  {articles.filter((item) => item.section === id).map((item) => (
                    <Button
                      key={item.id} variant="ghost" label={tr(item.title)}
                      aria-current={articleId === item.id && !searching ? 'page' : undefined}
                      onClick={() => openArticle(item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <main className="helpMain" ref={page}>
          <div className="helpContent">
            <div className="helpSearch">
              {home && (
                <>
                  <span className="helpEyebrow">A&D Voice</span>
                  <h1>{tr('Что хотите сделать?')}</h1>
                  <p>{tr('Выберите раздел или опишите задачу своими словами.')}</p>
                </>
              )}
              <TextField
                value={query} onValueChange={setQuery}
                className="helpSearchField"
                aria-label={tr('Поиск по инструкции')}
                placeholder={tr('Например: не слышу себя или как записать песню')}
                startAdornment={<Icon name="search" size={19} />}
              />
            </div>

            {searching || (!article && section) ? (
              <section className="helpResults" aria-labelledby="helpResultsTitle">
                <h1 id="helpResultsTitle">
                  {tr(searching ? 'Результаты поиска' : section ? sections[section].title : 'Инструкция')}
                </h1>
                <div className="helpTopicList">
                  {results.map((item) => (
                    <Button
                      key={item.id} variant="ghost" className="helpResult"
                      onClick={() => openArticle(item.id)}
                    >
                      <span className="helpResultContent">
                        <Icon name={sections[item.section].icon} size={20} />
                        <span>
                          <strong>{tr(item.title)}</strong>
                          <small>{tr(sections[item.section].title)}</small>
                        </span>
                        <Icon name="back" size={16} style={{ transform: 'rotate(180deg)' }} />
                      </span>
                    </Button>
                  ))}
                </div>
                {!results.length && (
                  <p role="status">{tr('Попробуйте написать короче: «микрофон», «задержка», «записать» или выберите раздел.')}</p>
                )}
              </section>
            ) : article ? (
              <article className="helpArticle" key={article.id} aria-labelledby="helpArticleTitle">
                <span className="helpEyebrow">{tr(sections[article.section].title)}</span>
                <h1 id="helpArticleTitle">{tr(article.title)}</h1>
                <ol className="helpSteps">
                  {article.steps.map((step, index) => (
                    <li className="helpStep" key={step.title}>
                      <div className="helpStepCopy">
                        <div className="helpStepTitle">
                          <span>{index + 1}</span>
                          <h2>{tr(step.title)}</h2>
                        </div>
                        <p>{tr(step.body)}</p>
                        {step.settings && (
                          <Button
                            className="helpAction" variant="ghost" icon="settings"
                            onClick={() => openSettings(step.settings)}
                            label={tr(settingsActions[step.settings])}
                          />
                        )}
                        {step.details && (
                          <details className="helpDetails">
                            <summary>{tr(step.details[0])}</summary>
                            <p>{tr(step.details[1])}</p>
                          </details>
                        )}
                        {step.clip && (
                          <details className="helpDetails helpClip">
                            <summary><Icon name="play" size={15} />{tr('Посмотреть короткое видео')}</summary>
                            <video
                              controls playsInline preload="none"
                              poster={mediaRoot + visuals[step.visual].image + '.jpg'}
                              aria-label={tr(step.title)}
                            >
                              <source src={import.meta.env.BASE_URL + 'help/' + step.clip + '.webm'} type="video/webm" />
                              {tr('Основные действия описаны над видео.')}
                            </video>
                          </details>
                        )}
                      </div>
                      <button
                        type="button" className="helpScreenshot"
                        onClick={() => setZoom({ visual: step.visual, title: step.title, number: index + 1 })}
                        aria-label={tr('Увеличить изображение: {name}', { name: tr(step.title) })}
                      >
                        {screenshot(step.visual, step.title, index + 1, true)}
                        <span className="helpZoomHint">
                          <Icon name="search" size={14} />{tr('Нажмите, чтобы увеличить')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                {nextArticle && (
                  <footer className="helpNext">
                    <span>{tr('Следующий шаг')}</span>
                    <Button variant="ghost" onClick={() => openArticle(nextArticle.id)}>
                      {tr(nextArticle.title)}
                      <Icon name="back" size={16} style={{ transform: 'rotate(180deg)' }} />
                    </Button>
                  </footer>
                )}
              </article>
            ) : (
              <>
                <div className="helpHomeGrid">
                  {sectionEntries.map(([id, item]) => (
                    <Button
                      key={id} variant="ghost" className="helpCategory"
                      onClick={() => showSection(id)}
                    >
                      <span className="helpCategoryContent">
                        <Icon name={item.icon} size={28} surface="tile" />
                        <span>
                          <strong>{tr(item.title)}</strong>
                          <small>{tr(item.description)}</small>
                        </span>
                        <Icon name="back" size={16} style={{ transform: 'rotate(180deg)' }} />
                      </span>
                    </Button>
                  ))}
                </div>
                <section className="helpQuick" aria-labelledby="helpQuickTitle">
                  <h2 id="helpQuickTitle">{tr('Быстрые ответы')}</h2>
                  <div>
                    {articles.filter(({ id }) => quickAnswers.includes(id)).map((item) => (
                      <Button
                        key={item.id} variant="ghost" className="helpQuickLink"
                        onClick={() => openArticle(item.id)}
                      >
                        <Icon name="wrench" size={17} />
                        {tr(item.title)}
                        <Icon name="back" size={15} style={{ transform: 'rotate(180deg)' }} />
                      </Button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </main>
      </div>
      <Dialog
        className="helpZoomDialog"
        open={zoom !== null}
        onOpenChange={(open) => { if (!open) setZoom(null); }}
        width="full" title={zoom ? tr(zoom.title) : ''}
        closeLabel={tr('closeDialog')} cancelLabel={false} confirmLabel={false}
      >
        {zoom && screenshot(zoom.visual, zoom.title, zoom.number)}
      </Dialog>
    </div>
  );
});

export default HelpPage;
